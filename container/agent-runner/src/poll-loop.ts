import { outcomeReportingEnabled, OUTCOME_REPLY_NUDGE } from './outcome-reporting.js';
import { isAdmissibleOutcomeRequestSource } from './outcome-reporting-schema.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { evaluateAdmission } from './admission-gate.js';
import { findByName, findByRouting, findPeerName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  getMessageIn,
  markProcessing,
  markCompleted,
  markScriptSkipped,
  type MessageInRow,
} from './db/messages-in.js';
import { getConfig } from './config.js';
import {
  clearContextTokens,
  clearSubagents,
  setOwnConversation,
  setTurnSettings,
  withStatusSubtext,
} from './turn-status.js';
import { writeMessageOut } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import { touchHeartbeat } from './heartbeat.js';
import { clearStaleProcessingAcks } from './db/container-state.js';
import {
  clearContinuation,
  clearCurrentInReplyTo,
  getContinuation,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentInReplyTo,
} from './db/session-state.js';
import {
  advanceMemoryContextEpoch,
  clearCurrentLifecycleStatus,
  getCurrentLifecycleStatus,
  rememberRequestCandidates,
  setCurrentLifecycleStatus,
  beginProviderBusyScope,
  classifyTrigger,
  hasChatOutboundAfter,
  maxOutboundSeq,
  claimPrimaryRetryRequest,
  clearDoneProposal,
  clearPrimaryRetryRequest,
  clearStickyEffort,
  clearStickyModel,
  clearStickyUltracode,
  clearWorkContinuationIfMatches,
  getActiveRepositoryMountBarrier,
  getSessionSpawnTaskId,
  getStickyEffort,
  getStickyFast,
  getStickyModel,
  getStickyUltracode,
  getWorkContinuation,
  isWorkContinuationRunnable,
  markWorkContinuationRunning,
  recordTurnUsage,
  endProviderBusyScope,
  releaseProcessingClaims,
  requeueWorkContinuationIfMatches,
  resetWorkContinuationForRealInbound,
  retainCompleteRecallUnits,
  setChatLimit,
  chatBudgetExhausted,
  setProviderTurnExecuting,
  markProviderQueryEvent,
  resetProviderQueryEvent,
  setStickyEffort,
  setStickyFast,
  setStickyModel,
  setStickyUltracode,
  shouldPostInfraWarning,
  type TurnTrigger,
} from './modules/mailbox/index.js';
import { clearBatchAnchors, getBatchAnchor, setCurrentBatchAnchors } from './current-batch.js';
import { modelBelongsToProvider } from './providers/model-vocabulary.js';
import { formatLocalTime, TIMEZONE } from './timezone.js';
import { formatCredentialRotationNotice } from './credential-rotation-notice.js';
import {
  formatMessages,
  extractAttachments,
  extractRouting,
  categorizeMessage,
  nativeSlashCommandPrompt,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderExchange,
  PromptAttachment,
} from './providers/types.js';
import { autoCommitDirtyWorktrees, type AutoSaveResult } from './worktree-autosave.js';
import { buildSessionRecap, wrapRecap } from './session-recap.js';
import { ensureFreshContextBootstrap } from './memory/bootstrap.js';
import { isFreshContextTaskBatch, sessionHasOpenWork, startsFreshFire } from './fresh-context-task.js';
import { loadTaskListState, markTaskListStale, taskListEnabled, taskListReminder } from './task-list.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function resetProviderContext(providerName: string): void {
  clearContinuation(providerName);
  advanceMemoryContextEpoch(providerName);
}

/** Consecutive corrupt reads (~5s at 500ms) before exiting so host-sweep respawns with a fresh mount. */
const CORRUPTION_STREAK_EXIT = 10;

// Full jitter is load-bearing: sibling containers hit the same overload in
// lockstep. 30 tries × 30s cap stays under host-sweep's 30-min idle ceiling.
const TRANSIENT_OVERLOAD_MAX_TRIES = 30;
/** Releases per container of a mid-turn follow-up whose stream ended unconsumed. */
const FOLLOW_UP_MAX_RELEASES = 1;
const followUpReleaseCounts = new Map<string, number>();
const TRANSIENT_OVERLOAD_BASE_MS = 1500;
const TRANSIENT_OVERLOAD_CAP_MS = 30_000;
const TRANSIENT_OVERLOAD_HEARTBEAT_MS = 10_000;

/** Capped exponential backoff with full jitter for retry attempt `n` (0-based). */
export function transientOverloadDelayMs(n: number, rand: number = Math.random()): number {
  const ceil = Math.min(TRANSIENT_OVERLOAD_CAP_MS, TRANSIENT_OVERLOAD_BASE_MS * 2 ** n);
  return Math.floor(ceil / 2 + rand * (ceil / 2));
}

/**
 * The prompt is replaced by a pointer when the resumed transcript already holds
 * it, so the batch is not in context twice. Pass `rotation` only from the
 * rotation retry: the notice must never appear on a retry that swapped nothing.
 */
function formatCredentialRetryPrompt(
  prompt: string,
  batch: MessageInRow[],
  rotation?: { rotated: boolean; position?: number; ringSize?: number },
  promptAlreadyInTranscript = false,
): string {
  const task = batch.find((message) => message.kind === 'task');
  const occurrence = task ? ` Task occurrence ID: ${JSON.stringify(task.id)}.` : '';
  const rotationNotice =
    rotation?.rotated && rotation.position !== undefined && rotation.ringSize !== undefined
      ? `${formatCredentialRotationNotice({ position: rotation.position, ringSize: rotation.ringSize })}\n\n`
      : '';
  return (
    '<runner-retry-provenance>\n' +
    'A retryable upstream failure interrupted an earlier attempt for this same inbound batch.' +
    `${occurrence} The runner has not recorded a completed result for this batch. ` +
    'Treat the repeated payload below as retry context, not a new delivery. ' +
    'Before repeating side effects, inspect durable effects already produced, then continue the unfinished work.\n' +
    '</runner-retry-provenance>\n\n' +
    rotationNotice +
    (promptAlreadyInTranscript
      ? 'The interrupted batch is the inbound message this attempt already recorded above in this conversation; it is not repeated here.\n'
      : prompt)
  );
}

// A 5-min Codex idle-watchdog fire is almost always a real wedge, and each retry
// costs another full 5 min, so retry once.
const CODEX_IDLE_RETRY_MAX = 1;
const CODEX_IDLE_RETRY_BASE_MS = 3000;

export function buildWorkContinuationPrompt(task: string): string {
  return (
    `<system>You durably handed yourself this unfinished task, and it has not been done:\n${task}\n` +
    `Continue with it NOW — start the work immediately. Do not re-acknowledge, summarize, or announce; ` +
    `if you must say something mid-work, use send_message. End this turn only when the task is done, ` +
    `blocked on the user, cancelled, or replaced through continue_work.</system>`
  );
}

/**
 * A corrupt READ view (usually Docker Desktop macOS cross-mount page cache), not
 * file damage: reopening the handle does not recover, so the caller must exit.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type ProviderErrorEvent = Extract<ProviderEvent, { type: 'error' }>;

export class ProviderEventError extends Error {
  readonly retryable: boolean;
  readonly classification: string | undefined;

  constructor(readonly event: ProviderErrorEvent) {
    super(event.message);
    this.name = 'ProviderEventError';
    this.retryable = event.retryable;
    this.classification = event.classification;
  }
}

function isProviderSystemError(err: unknown): boolean {
  return err instanceof ProviderEventError && err.classification === 'system_error';
}

/** Account-level quota wall: unrecoverable in this container until the provider window resets. */
function isProviderQuotaExhausted(err: unknown): boolean {
  return err instanceof ProviderEventError && err.classification === 'quota';
}

export interface ProviderUnavailableDetail {
  /** Provider-MEASURED recovery instant (ISO) — see ProviderEvent error `resetAt`. */
  resetAt?: string | null;
  /** `system_error` when the failure is the coarse Codex systemError wedge; the host bounds that park at 60 min. */
  reason?: string | null;
}

/** `resetAt` and `reason` appear only when known, so an older host sees the row it always did. */
export function buildProviderUnavailableReport(
  activeProvider: string,
  recognizedQuota: boolean,
  message: string,
  fallbackProvider: string,
  detail: ProviderUnavailableDetail = {},
): Record<string, unknown> {
  return {
    action: 'provider_unavailable',
    provider: activeProvider,
    classification: recognizedQuota ? 'quota' : 'unavailable',
    message: message.slice(0, 500),
    fallbackProvider,
    ...(detail.resetAt ? { resetAt: detail.resetAt } : {}),
    ...(detail.reason ? { reason: detail.reason } : {}),
  };
}

async function reportProviderUnavailable(
  providerName: string | null,
  message: string,
  recognizedQuota: boolean,
  detail: ProviderUnavailableDetail = {},
): Promise<boolean> {
  let runnerConfig: ReturnType<typeof getConfig>;
  try {
    runnerConfig = getConfig();
  } catch {
    // Config not loaded (tests, pre-bootstrap): keep the visible error.
    return false;
  }
  const fallbackProvider = runnerConfig.providerFallback?.provider;
  if (!fallbackProvider) return false;
  const activeProvider = providerName ?? runnerConfig.provider;
  // Already on the fallback: record the outage but let the error reach the user,
  // or the session bounces between two dead providers forever. This keeps at
  // most one attempt silent.
  const alreadyOnFallback = Boolean(
    typeof process !== 'undefined' ? process.env?.NANOCLAW_PROVIDER_OVERRIDE : undefined,
  );
  try {
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify(
        buildProviderUnavailableReport(activeProvider, recognizedQuota, message, fallbackProvider, detail),
      ),
    });
    const suppress = !alreadyOnFallback;
    log(
      `Provider ${activeProvider} unusable (${recognizedQuota ? 'quota' : 'unrecovered failure'}); ` +
        `reported for fallback to ${fallbackProvider}${suppress ? ' — suppressing the chat error' : ''}`,
    );
    return suppress;
  } catch (err) {
    log(`Failed to report provider outage: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const FILE_EVENT_MAX_BYTES = 50 * 1024 * 1024;
const FILE_EVENT_ALLOWED_PREFIXES = [
  '/home/node/.codex/generated_images',
  '/workspace/agent',
  '/workspace/worktrees',
  '/workspace/workgroup',
  '/workspace/extra',
  '/tmp/',
];

export function isAllowedFileEventPath(p: string): boolean {
  return FILE_EVENT_ALLOWED_PREFIXES.some((prefix) => {
    const boundary = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
    return p === prefix || p.startsWith(boundary);
  });
}

function sanitizeOutboundFilename(filename: string): string {
  const base = path
    .basename(filename)
    .replace(/[^\w .@()+,=[\]-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return base && base !== '.' && base !== '..' ? base : `attachment-${Date.now()}`;
}

/** Match BOTH anchors: either alone false-positives on prose that discusses the AUP. */
export function isAupRefusal(text: string): boolean {
  return text.includes('Claude Code is unable to respond') && text.includes('anthropic.com/legal/aup');
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  /** Task pins were validated for the primary, so they must not override the fallback's config. */
  providerFallbackActive?: boolean;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
  autosaveWorktrees?: (reason: string) => Promise<AutoSaveResult>;
}

async function checkpointTurnEnd(autosaveWorktrees: (reason: string) => Promise<AutoSaveResult>): Promise<void> {
  const autosave = await autosaveWorktrees('turn end');
  if (autosave.committed.length > 0 || autosave.failed.length > 0) {
    log(
      `autosave: committed=[${autosave.committed.join(',')}] failed=[${autosave.failed.join(',')}] skipped=${autosave.skipped.length}`,
    );
  }
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  const runnerId = randomUUID();
  const processQueryFallbackOptions = {
    ignoreTaskFlagIntents: config.providerFallbackActive === true,
    providerFallbackActive: config.providerFallbackActive === true,
  };
  const autosaveWorktrees = config.autosaveWorktrees ?? autoCommitDirtyWorktrees;
  const idleSuppressedContinuationIds = new Set<string>();
  const suppressContinuationUntilRealInbound = (id: string): void => {
    idleSuppressedContinuationIds.add(id);
  };
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);
  let freshContextBootstrapRequired = continuation === undefined;

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      resetProviderContext(config.providerName);
      continuation = undefined;
      freshContextBootstrapRequired = true;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    if (evaluateAdmission()) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }
    // System rows are MCP tool responses; only recall_context reaches the prompt.
    // isFirstPoll: on_wake rows fire only on a fresh container's first poll.
    const messages = getPendingMessages(isFirstPoll).filter((m) => {
      if (m.kind !== 'system') return true;
      try {
        const parsed = JSON.parse(m.content) as { subtype?: string };
        return parsed.subtype === 'recall_context';
      } catch {
        return false;
      }
    });
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    const hasTriggeringMessage = messages.some((m) => m.trigger === 1);

    // Accumulated trigger=0 context must not starve promised durable work; the
    // rows stay pending for the next real inbound turn.
    if (!hasTriggeringMessage) {
      const pending = getWorkContinuation();
      if (pending && !idleSuppressedContinuationIds.has(pending.id) && isWorkContinuationRunnable(pending, runnerId)) {
        // A fence can commit while the pending batch is read: never start queued
        // work once repository admission is closed.
        if (evaluateAdmission()) continue;
        const runningWork = markWorkContinuationRunning(pending.id, runnerId);
        if (runningWork) {
          if (evaluateAdmission()) {
            requeueWorkContinuationIfMatches(runningWork.id, runnerId);
            continue;
          }
          const sourceMessage = runningWork.source_message_id ? getMessageIn(runningWork.source_message_id) : undefined;
          const sourceBatch = sourceMessage ? [sourceMessage] : [];
          const routing = extractRouting(sourceBatch);
          const prompt = buildWorkContinuationPrompt(runningWork.task);
          // Budget inherits from the continuation's source row; with no source
          // row keep the current one, so an empty batch never lifts a mute/cap.
          if (sourceBatch.length > 0) applyChatBudget(sourceBatch);
          const settings = applyFlagBatch([], routing, config.providerName);
          log(`Resuming durable continuation: ${runningWork.task.slice(0, 120)}`);
          config.provider.resetRotationCycle?.();
          setCurrentInReplyTo(routing.inReplyTo);
          setCurrentBatchAnchors(sourceBatch);
          rememberRequestCandidates(sourceBatch);
          let query: AgentQuery | undefined;
          const abortDirectQuery = () => query?.abort();
          try {
            query = config.provider.query({
              prompt,
              continuation,
              cwd: config.cwd,
              model: settings.model,
              effort: settings.effort,
              ultracode: settings.ultracode,
              fast: settings.fast,
              systemContext: config.systemContext,
            });
            if (config.signal?.aborted) query.abort();
            else config.signal?.addEventListener('abort', abortDirectQuery, { once: true });
            const result = await processQuery(
              query,
              routing,
              [],
              config.providerName,
              config.provider.onExchangeComplete?.bind(config.provider),
              prompt,
              continuation,
              settings,
              runnerId,
              runningWork.id,
              suppressContinuationUntilRealInbound,
              'continuation',
              undefined,
              processQueryFallbackOptions,
            );
            if (result.continuation && result.continuation !== continuation) {
              continuation = result.continuation;
              setContinuation(config.providerName, continuation);
            }
          } catch (err) {
            requeueWorkContinuationIfMatches(runningWork.id, runnerId);
            idleSuppressedContinuationIds.add(runningWork.id);
            log(`Durable continuation paused after query error: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            config.signal?.removeEventListener('abort', abortDirectQuery);
            clearCurrentInReplyTo();
            clearBatchAnchors();
          }
          // The checkpoint below is real work the host would otherwise read as idle.
          beginProviderBusyScope();
          try {
            await emitTurnEnd();
            await checkpointTurnEnd(autosaveWorktrees);
          } finally {
            endProviderBusyScope();
          }
          continue;
        }
      }
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!hasTriggeringMessage) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    let routing = extractRouting(messages);
    const savedWork = getWorkContinuation();
    if (!routing.platformId && savedWork?.source_message_id && isContinuationRecoveryBatch(messages)) {
      const sourceMessage = getMessageIn(savedWork.source_message_id);
      if (sourceMessage) {
        const sourceRouting = extractRouting([sourceMessage]);
        routing = {
          ...sourceRouting,
          quietStatus: routing.quietStatus,
          taskRun: routing.taskRun,
          selfWake: routing.selfWake,
        };
      }
    }

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    let normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        resetProviderContext(config.providerName);
        freshContextBootstrapRequired = true;
        if (taskListEnabled()) markTaskListStale(getAgentMailbox().operations);
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    // Recall pairs survive command admission together or not at all.
    normalMessages = retainCompleteRecallPairs(messages, normalMessages);

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: Array<{ id: string; reason: string }> = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = retainCompleteRecallPairs(normalMessages, preTask.keep);
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    // No admissible trigger survived the scripts: leave the context rows
    // unclaimed so they ride the next turn.
    if (!keep.some(isAdmissibleTrigger)) {
      log(
        `All ${normalMessages.length} non-command message(s) gated by script or no admissible trigger, skipping query`,
      );
      continue;
    }

    // The barrier may have committed while scripts/settings were awaited:
    // re-check at the final admission seam before claiming.
    if (evaluateAdmission()) continue;
    const keptIds = keep.map((m) => m.id);
    const trigger = classifyTrigger(keep);
    markProcessing(keptIds);
    rememberRequestCandidates(keep);
    clearCurrentLifecycleStatus();
    if (outcomeReportingEnabled() && !routing.taskRun && triggeringHumanLivenessInbound(keep) && !routing.quietStatus) {
      const lifecycleStatusId = generateId();
      const lifecycleAnchor =
        routing.channelType && routing.platformId
          ? (getBatchAnchor(routing.channelType, routing.platformId) ?? routing.inReplyTo)
          : routing.inReplyTo;
      await writeMessageOut({
        id: lifecycleStatusId,
        in_reply_to: lifecycleAnchor,
        kind: 'status',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({
          text: 'Accepted · working',
          reporting: { version: 1, purpose: 'liveness', state: 'working' },
        }),
      });
      setCurrentLifecycleStatus(lifecycleStatusId);
    }
    if (hasRealInbound(keep)) {
      resetWorkContinuationForRealInbound();
      // Real input retracts a standing close proposal; system rows (close
      // wrap-up, ceiling notice) deliberately do not.
      clearDoneProposal();
      idleSuppressedContinuationIds.clear();
    }

    applyChatBudget(keep);
    const flagBatch = effectiveTurnSettings(keep, routing, config.providerName, config.providerFallbackActive === true);
    // Running on the primary spends any earlier retry-request cooldown, so a
    // fresh outage can ask again.
    if (config.providerFallbackActive !== true) clearPrimaryRetryRequest();
    if (flagBatch.ignoredModel !== undefined)
      await noteIgnoredModel(
        flagBatch.ignoredModel,
        config.providerName,
        config.providerFallbackActive === true,
        routing,
        flagBatch.ignoredModelWasExplicit === true,
      );
    const effectiveModel = flagBatch.model;
    const effectiveEffort = flagBatch.effort;
    const effectiveUltracode = flagBatch.ultracode;
    const effectiveFast = flagBatch.fast;

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    // A fresh scheduled fire resets like /clear, without its chat notice.
    const freshFire = continuation !== undefined && startsFreshFire(keep);
    if (freshFire) {
      log('Fresh-context task fire: not resuming the stored session');
      continuation = undefined;
      resetProviderContext(config.providerName);
      freshContextBootstrapRequired = true;
    }
    const formattedPrompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);
    // A reset that is not /clear keeps the work going, so it restores the task list.
    const listReminder =
      freshContextBootstrapRequired && taskListEnabled()
        ? taskListReminder(loadTaskListState(getAgentMailbox().operations))
        : null;
    const prompt = freshContextBootstrapRequired
      ? ensureFreshContextBootstrap(listReminder ? `${listReminder}\n\n${formattedPrompt}` : formattedPrompt)
      : formattedPrompt;
    freshContextBootstrapRequired = false;

    log(
      `Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}` +
        (effectiveModel ? ` model=${effectiveModel}` : '') +
        (effectiveEffort ? ` effort=${effectiveEffort}` : '') +
        (config.providerName === 'codex' ? ` fast=${effectiveFast ? 'on' : 'off'}` : ''),
    );

    // Per turn, so a since-healed credential is reachable again; otherwise a
    // turn that exhausted the ring could never rotate again.
    config.provider.resetRotationCycle?.();

    const batchAttachments = extractAttachments(keep);

    // A rotation retry trusts only a transcript copy of the prompt recorded after this.
    const batchStartedAt = Date.now();
    const query = config.provider.query({
      prompt,
      attachments: batchAttachments,
      continuation,
      cwd: config.cwd,
      model: effectiveModel,
      effort: effectiveEffort,
      ultracode: effectiveUltracode,
      fast: effectiveFast,
      systemContext: config.systemContext,
    });

    // Commands and skipped task rows were already completed, so this is exactly what was claimed.
    const processingIds = keptIds;
    // Fallback handoff: rows stay claimed-but-unfinished so the respawned container answers them.
    let deferredToFallback = false;
    let deferredForRepositoryBarrier = false;
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    setCurrentBatchAnchors(keep);
    let abortActiveQuery: (() => void) | undefined;
    if (config.signal) {
      abortActiveQuery = () => {
        query.abort();
      };
      if (config.signal.aborted) {
        query.abort();
      } else {
        config.signal.addEventListener('abort', abortActiveQuery, { once: true });
      }
    }
    // INVARIANT: one outcome record per admitted task fire, however many attempts.
    // Keyed by task row ids so retries coalesce: a recovered fire must not push a
    // series to the alert threshold, and an exhausted one must still write a row.
    const fireOutcomes = new Map<string, FireOutcome>();
    const mergeTaskTurns = (turns: TaskTurnRecord[] | undefined): void => {
      for (const turn of turns ?? []) {
        if (turn.outcome) fireOutcomes.set(turn.key, turn.outcome);
      }
    };
    // Written as soon as the turn reports it: a task stream never ends, and after
    // the host reaps the container nothing can be written. The key is reserved
    // before the write, so a retry can neither add a second record nor replace one.
    const writtenFireKeys = new Set<string>();
    const writeFireOutcome = async (key: string, outcome: FireOutcome): Promise<void> => {
      if (writtenFireKeys.has(key)) return;
      writtenFireKeys.add(key);
      // A throwing write committed nothing (its own transaction), so retry in place briefly.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const taskMessageIds = key.split(',').filter((id) => getMessageIn(id)?.kind === 'task');
          await autoAppendTaskLog(outcome.text, outcome.isError, outcome.model, taskMessageIds);
          return;
        } catch (logErr) {
          const reason = logErr instanceof Error ? logErr.message : String(logErr);
          if (attempt === 3) {
            log(`Could not record task run outcome: ${reason}`);
            return;
          }
          log(`Task run outcome write failed (attempt ${attempt} of 3), retrying: ${reason}`);
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    };
    const reportTaskOutcome = async (key: string, reported: FireOutcome): Promise<void> => {
      fireOutcomes.set(key, reported);
      const outcome = resolveFireOutcome({
        taskRun: routing.taskRun === true,
        deferredForRepositoryBarrier,
        deferredToFallback,
        reported,
        model: effectiveModel,
      });
      if (outcome) await writeFireOutcome(key, outcome);
    };
    /** Set when every attempt threw, so the `finally` can synthesise a failure. */
    let fireErrorMessage: string | undefined;
    const initialTurnKey = processingIds.join(',');
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
        runnerId,
        undefined,
        suppressContinuationUntilRealInbound,
        trigger,
        reportTaskOutcome,
        processQueryFallbackOptions,
      );
      mergeTaskTurns(result.taskTurns);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);
      // The failed query's CLI child may still be running. Abort it before any
      // recovery starts a fresh query, or it keeps burning failures on the
      // exhausted credential. abort() is idempotent.
      query.abort();
      // Retries resume the session the fresh fire's first attempt stored at `init`.
      if (freshFire && continuation === undefined) continuation = getContinuation(config.providerName);
      const pausedWork = getWorkContinuation();
      if (pausedWork?.phase === 'queued') idleSuppressedContinuationIds.add(pausedWork.id);

      let recovered = false;
      const repositoryRecoveryAllowed = (): boolean => {
        if (deferredForRepositoryBarrier) return false;
        const epoch = getActiveRepositoryMountBarrier();
        if (epoch === null) return true;
        deferredForRepositoryBarrier = true;
        log(`Repository mount barrier ${epoch} suppressed in-turn provider recovery; requeueing the admitted batch`);
        return false;
      };

      // Close the no-await seam now; each retry branch re-checks at its own
      // admission point, since backoffs can sleep while a fence lands.
      repositoryRecoveryAllowed();

      // Heartbeat across the sleep, or host-sweep reaps the container as stale.
      const backOff = async (sleepMs: number): Promise<void> => {
        const beat = setInterval(touchHeartbeat, TRANSIENT_OVERLOAD_HEARTBEAT_MS);
        try {
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        } finally {
          clearInterval(beat);
        }
        touchHeartbeat();
      };

      // `model` undefined drops the per-turn pin. The retry query is aborted before
      // any error propagates, or it leaks its CLI child like the original.
      const retryInTurn = async (
        retryPrompt: string,
        from: string | undefined,
        model: string | undefined,
      ): Promise<void> => {
        let retryQuery: AgentQuery | undefined;
        try {
          retryQuery = config.provider.query({
            prompt: retryPrompt,
            attachments: batchAttachments,
            continuation: from,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model,
            effort: effectiveEffort,
            ultracode: effectiveUltracode,
            fast: effectiveFast,
          });
          const retryResult = await processQuery(
            retryQuery,
            routing,
            processingIds,
            config.providerName,
            config.provider.onExchangeComplete?.bind(config.provider),
            prompt,
            from,
            { model, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
            runnerId,
            undefined,
            suppressContinuationUntilRealInbound,
            trigger,
            reportTaskOutcome,
            processQueryFallbackOptions,
          );
          mergeTaskTurns(retryResult.taskTurns);
          if (retryResult.continuation && retryResult.continuation !== from) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
        } catch (retryErr) {
          retryQuery?.abort();
          throw retryErr;
        }
      };

      // Transient server overload: the credential is fine, so rotating is
      // pointless; back off and retry the same prompt and continuation.
      const transient = config.provider.isTransientOverload?.(err) ?? false;
      if (transient && repositoryRecoveryAllowed()) {
        for (let attempt = 0; attempt < TRANSIENT_OVERLOAD_MAX_TRIES && !recovered; attempt++) {
          const sleepMs = transientOverloadDelayMs(attempt);
          log(
            `Transient server overload — retry ${attempt + 1}/${TRANSIENT_OVERLOAD_MAX_TRIES} ` +
              `in ${sleepMs}ms (same prompt, no rotation)`,
          );
          await backOff(sleepMs);
          if (!repositoryRecoveryAllowed()) break;
          try {
            await retryInTurn(prompt, continuation, effectiveModel);
            recovered = true;
          } catch (retryErr) {
            // A different error ends the loop. A quota hit here does not rotate
            // this turn; the next message takes the normal rotation path.
            if (config.provider.isTransientOverload?.(retryErr)) continue;
            log(
              `Retry during transient overload hit a non-transient error: ` +
                `${retryErr instanceof Error ? retryErr.message : String(retryErr)} — surfacing`,
            );
            break;
          }
        }
        if (!recovered) {
          log(`Transient server overload — exhausted ${TRANSIENT_OVERLOAD_MAX_TRIES} retries`);
        }
      }

      // Codex idle stalls recover on the next message, so retry the same prompt in place, bounded.
      const codexIdle = !recovered && err instanceof ProviderEventError && err.classification === 'idle_timeout';
      if (codexIdle && repositoryRecoveryAllowed()) {
        for (let attempt = 0; attempt < CODEX_IDLE_RETRY_MAX && !recovered; attempt++) {
          const sleepMs = CODEX_IDLE_RETRY_BASE_MS * (attempt + 1);
          log(`Codex idle-timeout — retry ${attempt + 1}/${CODEX_IDLE_RETRY_MAX} in ${sleepMs}ms`);
          await backOff(sleepMs);
          if (!repositoryRecoveryAllowed()) break;
          try {
            await retryInTurn(prompt, continuation, effectiveModel);
            recovered = true;
          } catch (retryErr) {
            if (retryErr instanceof ProviderEventError && retryErr.classification === 'idle_timeout') {
              continue;
            }
            log(
              `Retry after codex idle-timeout hit a different error: ` +
                `${retryErr instanceof Error ? retryErr.message : String(retryErr)} — surfacing`,
            );
            break;
          }
        }
        if (!recovered) {
          log(`Codex idle-timeout — exhausted ${CODEX_IDLE_RETRY_MAX} retries`);
        }
      }

      // Cycle the credential ring until one succeeds; rotateApiKey returns
      // rotated:false once the cycle is spent, so the loop terminates. Ordered
      // before isContextTooLong, which can look retryable. The continuation
      // survives rotation (resume reads a local .jsonl). `!transient`: an
      // overload also matches isRetryable but was handled by the backoff above.
      let rotation =
        !transient && !recovered && repositoryRecoveryAllowed() && config.provider.isRetryable?.(err)
          ? config.provider.rotateApiKey?.()
          : undefined;
      while (rotation?.rotated && !recovered) {
        log(`Upstream transient error — rotated credential, retrying same batch in-turn with provenance`);
        if (!repositoryRecoveryAllowed()) break;
        try {
          const retryPrompt = formatCredentialRetryPrompt(
            prompt,
            keep,
            rotation,
            config.provider.transcriptHasPrompt?.(continuation, prompt, batchStartedAt) ?? false,
          );
          await retryInTurn(retryPrompt, continuation, effectiveModel);
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after credential rotation also failed: ${retryMsg}`);
          rotation = config.provider.isRetryable?.(retryErr) ? config.provider.rotateApiKey?.() : undefined;
        }
      }

      // Context-too-long: clear the continuation and retry once with a recap.
      // Gated on `continuation`: a first message already over the limit falls
      // through to a chat error.
      if (!recovered && repositoryRecoveryAllowed() && continuation && config.provider.isContextTooLong?.(err)) {
        log(`Context-too-long detected — clearing session and retrying once with fresh continuation`);
        continuation = undefined;
        resetProviderContext(config.providerName);
        freshContextBootstrapRequired = true;
        try {
          const recap = buildSessionRecap();
          const retryPrompt = ensureFreshContextBootstrap(
            (recap
              ? wrapRecap(recap, 'context-window-exceeded')
              : '[The prior session exceeded the model context window and was reset. Continuing fresh from here.]\n\n') +
              prompt,
          );
          freshContextBootstrapRequired = false;
          await retryInTurn(retryPrompt, undefined, effectiveModel);
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after context-too-long also failed: ${retryMsg}`);
          // The failed retry's `init` may have re-persisted a continuation; clear it again.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      } else if (!recovered && repositoryRecoveryAllowed() && continuation && config.provider.isSessionInvalid(err)) {
        // Stale session (transcript pruned, or id unknown in this container):
        // clear and retry once with a recap.
        log(`Stale session detected (${continuation}) — clearing and retrying with recap`);
        continuation = undefined;
        resetProviderContext(config.providerName);
        freshContextBootstrapRequired = true;
        try {
          const recap = buildSessionRecap();
          const retryPrompt = ensureFreshContextBootstrap(
            (recap
              ? wrapRecap(recap, 'stale-session-recovered')
              : '[The prior agent session transcript was unavailable and could not be resumed. Starting a fresh session.]\n\n') +
              prompt,
          );
          freshContextBootstrapRequired = false;
          await retryInTurn(retryPrompt, undefined, effectiveModel);
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after stale-session recovery also failed: ${retryMsg}`);
          // The failed retry's `init` may have re-persisted a continuation; clear it again.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // Codex yields a terminal systemError as an event, bypassing the
      // stale-session catch. A resumed thread in systemError is poison, so clear
      // once and retry fresh with a recap.
      if (!recovered && repositoryRecoveryAllowed() && continuation && isProviderSystemError(err)) {
        log(`Provider system_error (${continuation}) - clearing session and retrying with recap`);
        continuation = undefined;
        resetProviderContext(config.providerName);
        freshContextBootstrapRequired = true;
        try {
          const recap = buildSessionRecap();
          const retryPrompt = ensureFreshContextBootstrap(
            (recap
              ? wrapRecap(recap, 'provider-system-error-recovered')
              : '[The prior provider thread entered a terminal system error and was reset. Starting a fresh session.]\n\n') +
              prompt,
          );
          freshContextBootstrapRequired = false;
          await retryInTurn(retryPrompt, undefined, effectiveModel);
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after provider system_error also failed: ${retryMsg}`);
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // Model-scoped quota: a pinned tier can be spent while the account still
      // serves other models, and the rotation above replays the SAME model on
      // every credential, so it looks like a dead account. Retry once with the
      // pin dropped (`undefined` = each provider's group default), on every
      // provider. One attempt only: if the default fails too, the account is spent.
      const quotaExhausted = config.provider.isQuotaExhausted?.(err) ?? isProviderQuotaExhausted(err);
      if (!recovered && repositoryRecoveryAllowed() && quotaExhausted && effectiveModel !== undefined) {
        log(`Quota rejection while pinned to ${effectiveModel} — retrying once on the group's default model`);
        try {
          await retryInTurn(prompt, continuation, undefined);
          recovered = true;
          // Clear the pin only when sticky: a one-off `-m` stored nothing, and
          // clearing then would retire a pin the user never set.
          const stickyWasPinned = getStickyModel() === effectiveModel;
          if (stickyWasPinned) clearStickyModel();
          await noteModelQuotaFallback(effectiveModel, stickyWasPinned, err, routing);
        } catch (retryErr) {
          log(
            `Retry on the group's default model also failed: ` +
              `${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
        }
      }

      // A failure in-turn recovery could not fix is reported so the next spawn
      // routes to the fallback; only a recognized quota also silences the chat
      // error. The fire's failure is only recorded here: the `finally` decides
      // whether to write it, since `deferredToFallback` is set below.
      if (fireOutcomes.size === 0) fireErrorMessage = errMsg;
      if (deferredForRepositoryBarrier) releaseProcessingClaims(processingIds);
      const quotaHandled =
        !recovered &&
        !deferredForRepositoryBarrier &&
        (await reportProviderUnavailable(
          config.providerName,
          err instanceof Error ? err.message : String(err),
          quotaExhausted,
          err instanceof ProviderEventError
            ? {
                resetAt: err.event.resetAt ?? null,
                reason: err.classification === 'system_error' ? 'system_error' : null,
              }
            : {},
        ));
      deferredToFallback = quotaHandled;

      if (!recovered && !quotaHandled && !deferredForRepositoryBarrier) {
        // Deliberately un-deduped: an unclassified error can be a real bug.
        const providerEventErr = err instanceof ProviderEventError && err.retryable === false;
        const isInfraWarning = transient || codexIdle || providerEventErr;
        const chatText = transient
          ? `⚠️ Anthropic's API stayed overloaded across ${TRANSIENT_OVERLOAD_MAX_TRIES} retries — I couldn't finish this turn. I'll pick up from your next message.`
          : codexIdle
            ? `⚠️ The Codex app-server stalled across ${CODEX_IDLE_RETRY_MAX} retries — I couldn't finish this turn. I'll pick up from your next message.`
            : providerEventErr
              ? `⚠️ Turn ended with an error: ${err.message}. I'll pick up from your next message.`
              : `Error: ${errMsg}`;
        if (!isInfraWarning || shouldPostInfraWarning(chatText)) {
          await writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: chatText }),
          });
        }
      }
    } finally {
      // Exactly one task_log row per fire, written here where the final result
      // and deferral are both known. A DEFERRED batch (barrier, fallback) writes
      // nothing: its re-run records its own, and two failures for one postponed
      // fire can page a human. Best-effort: never mask the turn's own error.
      {
        const flush: Array<[string, FireOutcome | undefined]> =
          fireOutcomes.size > 0 ? [...fireOutcomes.entries()] : [[initialTurnKey, undefined]];
        for (const [key, reported] of flush) {
          if (writtenFireKeys.has(key)) continue;
          const outcome = resolveFireOutcome({
            taskRun: routing.taskRun === true,
            deferredForRepositoryBarrier,
            deferredToFallback,
            reported,
            errorMessage: fireErrorMessage,
            model: effectiveModel,
          });
          if (!outcome) continue;
          await writeFireOutcome(key, outcome);
        }
      }
      if (abortActiveQuery) config.signal?.removeEventListener('abort', abortActiveQuery);
      // Clear per-batch routing so MCP tools cannot stamp it on the next turn.
      clearCurrentInReplyTo();
      clearBatchAnchors();
    }

    // Busy bracket: the checkpoint below is real work the host would otherwise read as idle.
    beginProviderBusyScope();
    try {
      await emitTurnEnd();

      // Sibling agents share this checkout: turn-end code must never stage,
      // commit, reset, or remove another sibling's index lock.
      await checkpointTurnEnd(autosaveWorktrees);
    } finally {
      endProviderBusyScope();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly). The one exception is a batch handed
    // to the fallback provider: those rows keep their 'processing' claim,
    // which the next container's clearStaleProcessingAcks() releases, so the
    // fallback answers the message the primary could not.
    if (deferredForRepositoryBarrier) {
      log(`Deferred ${processingIds.length} message(s) until the repository mount barrier is released`);
    } else if (deferredToFallback) {
      log(`Deferred ${processingIds.length} message(s) to the fallback provider — not marking completed`);
    } else {
      markCompleted(processingIds);
      log(`Completed ${processingIds.length} message(s) (commands=${commandIds.length}, skipped=${skipped.length})`);
    }
  }
}

export function isAdmissibleTrigger(m: MessageInRow): boolean {
  if (m.trigger !== 1) return false;
  if (m.kind === 'system') return false;
  if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
  return true;
}

function hasRealInbound(messages: MessageInRow[]): boolean {
  return messages.some((message) => {
    if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return false;
    try {
      const content = JSON.parse(message.content) as { sender?: unknown; senderId?: unknown };
      return content.sender !== 'system' && content.senderId !== 'system';
    } catch {
      return true;
    }
  });
}

function triggeringHumanInbound(messages: MessageInRow[]): MessageInRow | undefined {
  return messages.find((m) => isAdmissibleTrigger(m) && m.channel_type !== 'agent' && hasRealInbound([m]));
}

function triggeringHumanLivenessInbound(messages: MessageInRow[]): MessageInRow | undefined {
  return triggeringHumanInbound(
    messages.filter((message) => {
      try {
        return isAdmissibleOutcomeRequestSource(message.kind, JSON.parse(message.content));
      } catch {
        return true;
      }
    }),
  );
}

function isContinuationRecoveryBatch(messages: MessageInRow[]): boolean {
  if (hasRealInbound(messages)) return false;
  return messages.some((message) => {
    if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return false;
    try {
      const content = JSON.parse(message.content) as { _system?: { kind?: unknown } };
      return content._system?.kind === 'agent_ceiling_respawn' || content._system?.kind === 'agent_host_restart';
    } catch {
      return false;
    }
  });
}

function recallTargetId(m: MessageInRow): string | null {
  if (m.kind !== 'system' || !m.id.startsWith('recall-')) return null;
  try {
    const parsed = JSON.parse(m.content) as { subtype?: unknown };
    return parsed.subtype === 'recall_context' ? m.id.slice('recall-'.length) : null;
  } catch {
    return null;
  }
}

export function retainCompleteRecallPairs(original: MessageInRow[], admitted: MessageInRow[]): MessageInRow[] {
  const originalRecallByTarget = new Map<string, string>();
  for (const row of original) {
    const targetId = recallTargetId(row);
    if (targetId !== null && original.some((candidate) => candidate.id === targetId)) {
      originalRecallByTarget.set(targetId, row.id);
    }
  }
  if (originalRecallByTarget.size === 0) return admitted;

  const admittedIds = new Set(admitted.map((row) => row.id));
  return admitted.filter((row) => {
    const targetId = recallTargetId(row);
    if (targetId !== null && originalRecallByTarget.get(targetId) === row.id) {
      return admittedIds.has(targetId);
    }
    const recallId = originalRecallByTarget.get(row.id);
    return recallId === undefined || admittedIds.has(recallId);
  });
}

/**
 * Pure (no DB writes). Admits nothing unless a real trigger survives: /clear and
 * non-recall system rows must not carry trigger=0 context into a prompt alone.
 * With a survivor: chat at any trigger, other non-system kinds at trigger=1, and
 * recall_context rows paired to a surviving trigger.
 */
export function selectInTurnFollowUps(allPending: MessageInRow[]): MessageInRow[] {
  // A fresh-context task fire must not join the running conversation unless the
  // session has open work; it resets once this query ends.
  const holdFresh = allPending.some((m) => isFreshContextTaskBatch([m])) && !sessionHasOpenWork();
  const completePending = retainCompleteRecallUnits(
    holdFresh ? allPending.filter((m) => !isFreshContextTaskBatch([m])) : allPending,
  );
  const isChatRow = (m: MessageInRow): boolean => m.kind === 'chat' || m.kind === 'chat-sdk';
  const triggerIds = new Set(completePending.filter(isAdmissibleTrigger).map((m) => m.id));
  if (triggerIds.size === 0) return [];

  return completePending.filter((m) => {
    if (m.kind === 'system') {
      try {
        const parsed = JSON.parse(m.content) as { subtype?: string };
        if (parsed.subtype !== 'recall_context') return false;
      } catch {
        return false;
      }
      const pairedTriggerId = m.id.startsWith('recall-') ? m.id.slice('recall-'.length) : null;
      return pairedTriggerId !== null && triggerIds.has(pairedTriggerId);
    }
    if (isChatRow(m) && isClearCommand(m)) return false;
    if (isChatRow(m)) return true;
    return m.trigger === 1;
  });
}

// The `recall-` id prefix is reserved for host-written recall rows: an adapter
// id starting with it would silently corrupt recall pairing.

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
export function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const commands: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Native slash dispatch fires only when the command starts the prompt,
        // so never flush the preceding recall/context rows before it.
        commands.push(nativeSlashCommandPrompt(msg, cmdInfo.text));
        continue;
      }
    }
    normalBatch.push(msg);
  }

  return [...commands, ...(normalBatch.length > 0 ? [formatMessages(normalBatch)] : [])].join('\n\n');
}

/** What one ATTEMPT produced. An attempt can carry SEVERAL admitted task turns. */
interface QueryResult {
  continuation?: string;
  /**
   * One entry per admitted task turn, in admission order: a stream can carry
   * several fires. `key` is stable across retries of a turn, distinct between fires.
   */
  taskTurns?: TaskTurnRecord[];
}

export interface TaskTurnRecord {
  key: string;
  outcome?: FireOutcome;
  /** Ids of the prompts that started this turn, when the provider tracks them. */
  promptIds?: string[];
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  // Compared against current effective settings to detect a mid-turn change and reopen the query.
  querySettings: { model?: string; effort?: string; ultracode?: boolean; fast?: boolean },
  runnerId: string = randomUUID(),
  initialContinuationId?: string,
  onContinuationPaused?: (id: string) => void,
  // What caused the batch that started this call; applied to every result it
  // produces, including mid-stream follow-ups.
  trigger: TurnTrigger = 'unknown',
  // Called as soon as an outcome is known: a task stream never ends, so this
  // call can outlive its container and a held outcome would be lost.
  onTaskOutcome?: (key: string, outcome: FireOutcome) => Promise<void>,
  options: { ignoreTaskFlagIntents?: boolean; providerFallbackActive?: boolean } = {},
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  let taskBlockNudged = false;
  let notificationWatermark = maxOutboundSeq();
  const deliveredInterimBlocks = new Set<string>();
  const suppressedInterimTaskBlocks: TaskMessageBlock[] = [];
  // Set when a person's triggering message is admitted: the outbound watermark
  // and its conversation, read at an empty `result`. Decided from admitted ROWS,
  // not `trigger`, which labels a mixed batch `scheduled`. Uses the opening
  // batch's `taskRun`: in a task run final-text <message> blocks are inert.
  type ReplyDebt = { sinceSeq: number; channelType: string | null; platformId: string | null };
  // The person's row's channel, not the batch anchor: a mixed batch anchors on
  // its task row, which is the task's destination.
  const replyDebt = (rows: MessageInRow[], from: RoutingContext): ReplyDebt | null => {
    const human = routing.taskRun ? undefined : triggeringHumanInbound(rows);
    if (!human) return null;
    const own = human.platform_id != null;
    return {
      sinceSeq: maxOutboundSeq(),
      channelType: own ? (human.channel_type ?? null) : from.channelType,
      platformId: own ? human.platform_id : from.platformId,
    };
  };
  let humanReplyOwed: ReplyDebt | null = replyDebt(
    initialBatchIds.map((id) => getMessageIn(id)).filter((m): m is MessageInRow => m != null),
    routing,
  );
  // Retryable events (SDK `api_retry`) are the SDK's own mid-stream retry, not
  // turn-ending: surface the last only if the stream ends without a result.
  let sawResult = false;
  let lastRetryableErr: ProviderEventError | undefined;
  // The provider's resolved model, never the request: `querySettings` goes stale
  // when a follow-up applies a pin live, and an unpinned task fire requests
  // nothing at all (the group default).
  let modelInForce = query.resolvedModel ?? querySettings.model;
  // Effort is the provider's resolved value too: `querySettings.effort` is user
  // intent only. No `?? querySettings.effort`: `null` means no effort setting,
  // and falling back would show a clamped-away sticky effort as if it ran.
  setTurnSettings(modelInForce, query.resolvedEffort, querySettings.ultracode);
  setOwnConversation(routing.channelType, routing.platformId);
  /**
   * What the live stream is ACTUALLY set to. Comparing a batch against the
   * immutable `querySettings` after a live retarget makes a real change look
   * like none, and a human's turn silently inherits a task's settings.
   */
  let liveSettings: { model?: string; effort?: string; ultracode?: boolean; fast?: boolean } = { ...querySettings };
  /**
   * One slot per admitted task turn, reported up via `onTaskOutcome`, never
   * written here: this call is one ATTEMPT, so only the caller can keep a fire
   * to exactly one record.
   */
  const taskTurns: TaskTurnRecord[] = [];
  if (routing.taskRun && initialBatchIds.length > 0) {
    taskTurns.push({
      key: initialBatchIds.join(','),
      ...(query.initialPromptId ? { promptIds: [query.initialPromptId] } : {}),
    });
  }
  // Latest result that answered none of the runner's prompts, held in case the
  // provider later settles a prompt whose echo was dropped. Dropped only when the
  // fires open at its arrival are answered or settled; see the `settled` branch.
  let provisional: { outcome: FireOutcome; promptIds: string[] } | undefined;
  const openPromptIds = (): string[] => taskTurns.filter((t) => !t.outcome).flatMap((t) => t.promptIds ?? []);
  /**
   * With prompt ids, fills every open turn the result consumed (a nudge's answer
   * fills none); without, the OLDEST unanswered turn. A result arriving when all
   * are answered is a retry of the closed turn and is dropped: coalescing never
   * crosses turns.
   */
  const recordTaskTurn = async (outcome: FireOutcome, answered?: string[]): Promise<void> => {
    const oldest = taskTurns.find((t) => !t.outcome);
    const slots =
      answered === undefined
        ? oldest
          ? [oldest]
          : []
        : taskTurns.filter((t) => !t.outcome && t.promptIds?.some((id) => answered.includes(id)));
    for (const slot of slots) {
      slot.outcome = outcome;
      await onTaskOutcome?.(slot.key, outcome);
    }
  };
  // Each result consumes the oldest unanswered prompt, except a wrapping-retry
  // result. Unmaintained when the provider lacks `onExchangeComplete`.
  interface PromptLedgerEntry {
    prompt: string;
    continuationId?: string;
  }
  const archivePrompts: PromptLedgerEntry[] = [
    { prompt: initialPrompt, ...(initialContinuationId ? { continuationId: initialContinuationId } : {}) },
  ];

  /**
   * Pushed follow-ups not yet terminally acked. `completed` is final (nothing
   * re-delivers it), so a push completes only once a result CONSUMED its prompt
   * id (`answeredPrompts`, or a later `settled`): the CLI can answer a turn while
   * a push is still queued behind it. Providers without prompt ids fall back to
   * any `result`. Pushes still unconsumed are released in the `finally`.
   */
  type PendingFollowUp = { ids: string[]; promptId: string | undefined };
  let pendingFollowUps: PendingFollowUp[] = [];
  const completeConsumedFollowUps = (consumed: (f: PendingFollowUp) => boolean): void => {
    const consumedNow = pendingFollowUps.filter(consumed);
    if (consumedNow.length === 0) return;
    pendingFollowUps = pendingFollowUps.filter((f) => !consumed(f));
    markCompleted(consumedNow.flatMap((f) => f.ids));
  };

  const requeueLedgerHead = (suppress: boolean): void => {
    const continuationId = archivePrompts[0]?.continuationId;
    if (!continuationId) return;
    requeueWorkContinuationIfMatches(continuationId, runnerId);
    if (suppress) onContinuationPaused?.(continuationId);
  };

  // Provider between turns: set by `result`, cleared by every push. The ledger
  // cannot gate launches: a merged mid-turn push yields one result for two
  // entries, so its FIFO never empties again.
  let turnIdle = false;
  // Reset at the same push choke point as `turnIdle`.
  let turnStartedAtMs = Date.now();
  const pushToQuery = (message: string, attachments?: PromptAttachment[]): string | undefined => {
    turnIdle = false;
    // A pushed turn has no processing claim of its own, so this flag is all that
    // keeps the idle reaper off it.
    setProviderTurnExecuting(true);
    turnStartedAtMs = Date.now();
    const id = query.push(message, attachments);
    return typeof id === 'string' ? id : undefined;
  };

  const pauseAnsweredPrompt = (): void => {
    requeueLedgerHead(true);
    archivePrompts.shift();
  };

  /**
   * `ignoreLedger`: the poll tick saw provider idleness first-hand. Double launch
   * is impossible: markWorkContinuationRunning is a single-flight claim.
   */
  const maybeLaunchContinuation = (ignoreLedger: boolean): void => {
    // Queued real inbounds go first (their result revisits this), so a user stop
    // can cancel the record before its prompt is pushed.
    if (!ignoreLedger && archivePrompts.length > 0) return;
    if (getActiveRepositoryMountBarrier() !== null) return;
    // Work the provider has accepted but not yet answered would merge with the
    // continuation into one turn, and one result would answer both.
    if (query.hasQueuedWork?.()) return;
    const queued = getWorkContinuation();
    if (!queued || !isWorkContinuationRunnable(queued, runnerId)) return;
    const running = markWorkContinuationRunning(queued.id, runnerId);
    if (!running) return;
    if (getActiveRepositoryMountBarrier() !== null) {
      requeueWorkContinuationIfMatches(running.id, runnerId);
      query.end();
      return;
    }
    const prompt = buildWorkContinuationPrompt(running.task);
    log(`Starting durable continuation: ${running.task.slice(0, 120)}`);
    pushToQuery(prompt);
    archivePrompts.push({ prompt, continuationId: running.id });
  };

  const completeDeliveredPrompt = (): void => {
    const answered = archivePrompts.shift();
    if (answered?.continuationId) clearWorkContinuationIfMatches(answered.continuationId);
    maybeLaunchContinuation(false);
  };

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  // Once ending for a command, stop polling so rows are not reclaimed mid-teardown.
  let endedForCommand = false;
  // A deferred change can wait a whole long turn despite the host's ⚙️ ack; say
  // so once per pending change.
  let deferredSettingsNotice: string | null = null;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      // Either suppresses the continuation launch at the bottom.
      let admittedInbound = false;
      let pollFailed = false;
      try {
        const repositoryBarrier = getActiveRepositoryMountBarrier();
        if (repositoryBarrier !== null) {
          // The outer loop acknowledges only after processQuery returns, which
          // proves this query is drained.
          log(`Repository mount barrier ${repositoryBarrier} observed — ending active query after current work`);
          endedForCommand = true;
          query.end();
          return;
        }
        const allPending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (allPending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }
        // A due fresh-context fire needs the outer loop's reset. end() is safe
        // only between turns with no background work; until then the fire stays
        // pending (never pushed) and the next poll retries.
        if (
          allPending.some((m) => m.trigger === 1 && startsFreshFire([m])) &&
          turnIdle &&
          !resultScopeOpen &&
          !query.hasQueuedWork?.() &&
          !query.hasBackgroundWork?.()
        ) {
          log('Pending fresh-context task fire — ending the idle stream so outer loop can reset');
          endedForCommand = true;
          query.end();
          return;
        }

        // Providers with immutable runtime context defer a flag batch until idle:
        // ending an active Claude input stream cuts off its control channel.

        // No thread_id filter: mismatched thread ids between batch and follow-ups
        // deadlocked, and per-thread sessions already isolate threads.
        const candidates = selectInTurnFollowUps(allPending);
        if (candidates.length === 0) return;

        // Run pre-task scripts BEFORE claiming: a gated trigger would otherwise
        // leave the context rows hidden behind processing acks.
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(candidates);
        const keep: MessageInRow[] = retainCompleteRecallPairs(candidates, preTask.keep);
        const skipped = preTask.skipped;
        // MODULE-HOOK:scheduling-pre-task-followup:end

        // No admissible trigger survived: never push context-only into the stream.
        // Skipped task ids are still completed so the script is not re-run.
        if (!keep.some(isAdmissibleTrigger)) {
          if (skipped.length > 0) {
            markScriptSkipped(skipped);
            log(
              `Pre-task script skipped ${skipped.length} follow-up task(s); no admissible trigger remained, deferring context rows`,
            );
          }
          return;
        }

        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work.
        if (done) {
          if (skipped.length > 0) markScriptSkipped(skipped);
          return;
        }

        // applyFlagBatch persists flag stickies and re-reads effective settings,
        // catching both flag rows and mid-turn change_model writes. Providers
        // without live controls end the stream (rows stay pending); Claude applies
        // in place. Task suppression deliberately does NOT apply: `keep` is a
        // sub-batch, and a lone due task row would retarget a human's running turn.
        // Known limitation: a task joining a running stream inherits its settings.
        const fb = applyFlagBatch(keep, extractRouting(keep), providerName, {
          ignoreTaskFlagIntents: options.ignoreTaskFlagIntents,
        });
        // A `-m` for the other provider resolves to undefined and changes nothing: say it is ignored.
        if (fb.ignoredModel !== undefined) {
          await noteIgnoredModel(
            fb.ignoredModel,
            providerName,
            options.providerFallbackActive === true,
            extractRouting(keep),
            fb.ignoredModelWasExplicit === true,
          );
          // The stream can end during this await; rows claimed against a dead
          // query sit until stale detection.
          if (done) return;
        }
        const liveSettingsChanged =
          fb.model !== liveSettings.model ||
          fb.effort !== liveSettings.effort ||
          fb.ultracode !== liveSettings.ultracode;
        const fastChanged = fb.fast !== (liveSettings.fast ?? false);
        if (liveSettingsChanged || fastChanged) {
          // Codex fast mode is fixed at app-server start: a tier change must end
          // the query even when live controls exist.
          if (query.requiresRestartForRuntimeContext && liveSettingsChanged) {
            // Claude's system prompt is fixed at query start, so a new model/effort
            // needs a new query. end() is only safe between turns with no
            // background work: closing input mid-turn closes the control channel,
            // and open input keeps background subagents alive. Retry next idle poll.
            if (!turnIdle || resultScopeOpen || query.hasQueuedWork?.() || query.hasBackgroundWork?.()) {
              log(
                'Query settings changed but runtime context is immutable — deferring follow-up until the active query and result handling drain',
              );
              const acked = findAckedFlag(keep);
              const notice = acked && queuedSettingsNotice(acked.ack);
              if (acked && notice && notice !== deferredSettingsNotice) {
                deferredSettingsNotice = notice;
                const routing = extractRouting([acked.row]);
                await writeMessageOut({
                  id: generateId(),
                  kind: 'chat',
                  platform_id: routing.platformId,
                  channel_type: routing.channelType,
                  thread_id: routing.threadId,
                  content: JSON.stringify({ text: notice }),
                });
              }
              return;
            }
            log(
              `Query settings changed (${liveSettings.model ?? 'default'} → ${fb.model ?? 'default'}) — ` +
                'restarting at an idle boundary for a fresh runtime context; next query honors it',
            );
            endedForCommand = true;
            query.end();
            return;
          }
          if (fastChanged || !query.applySettings) {
            log(
              `Query settings changed (${liveSettings.model ?? 'default'} → ${fb.model ?? 'default'}, ` +
                `fast=${liveSettings.fast ? 'on' : 'off'} → ${fb.fast ? 'on' : 'off'}) — ` +
                'ending stream; next query honors it',
            );
            endedForCommand = true;
            query.end();
            return;
          }
          try {
            await query.applySettings({ model: fb.model, effort: fb.effort, ultracode: fb.ultracode });
            modelInForce = query.resolvedModel ?? fb.model;
            // The provider's getter already reflects the retarget, so it beats the requested value.
            setTurnSettings(modelInForce, query.resolvedEffort, fb.ultracode);
            liveSettings = { model: fb.model, effort: fb.effort, ultracode: fb.ultracode, fast: fb.fast };
          } catch (err) {
            log(
              `Live applySettings failed (${err instanceof Error ? err.message : String(err)}) — ` +
                'ending stream; outer loop reopens with the new model',
            );
            endedForCommand = true;
            query.end();
            return;
          }
          // The await widens the done-race; re-check before claiming.
          if (done) return;
        }

        const keptIds = keep.map((m) => m.id);
        const lateRepositoryBarrier = getActiveRepositoryMountBarrier();
        if (lateRepositoryBarrier !== null) {
          log(`Repository mount barrier ${lateRepositoryBarrier} committed before follow-up claim — ending query`);
          endedForCommand = true;
          query.end();
          return;
        }
        markProcessing(keptIds);
        if (hasRealInbound(keep)) {
          resetWorkContinuationForRealInbound();
          clearDoneProposal();
        }
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
        }
        const prompt = formatMessages(keep);
        // Refresh in_reply_to to the follow-up batch, or a mid-turn a2a reply
        // routes to the outer turn's source session.
        const followUpRouting = extractRouting(keep);
        setCurrentInReplyTo(followUpRouting.inReplyTo);
        setCurrentBatchAnchors(keep);
        rememberRequestCandidates(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        taskBlockNudged = false;
        notificationWatermark = maxOutboundSeq();
        // A new check-in restarts the watermark: progress sent for an earlier
        // request does not answer this one.
        const pushedDebt = replyDebt(keep, followUpRouting);
        const pushedHumanTrigger = pushedDebt !== null;
        if (pushedDebt) humanReplyOwed = pushedDebt;
        // A later occurrence is a SEPARATE fire with its own outcome slot, or a
        // failing series can stay under the escalation threshold forever.
        let admittedTurn: TaskTurnRecord | undefined;
        if (routing.taskRun) {
          const admittedTaskIds = keep.filter((m) => m.kind === 'task').map((m) => m.id);
          if (admittedTaskIds.length > 0) {
            admittedTurn = { key: admittedTaskIds.join(',') };
            taskTurns.push(admittedTurn);
          }
        }
        // A push into a RUNNING turn is merged, and only result text is
        // dispatched, so an acknowledgment typed between tool calls reaches nobody.
        const midTurnNote =
          pushedHumanTrigger && !turnIdle
            ? outcomeReportingEnabled()
              ? '\n\n<system>Reminder: text written between tool calls is an internal work record. ' +
                'To answer now, call send_message with purpose="reply".</system>'
              : '\n\n<system>Reminder: unwrapped text you write between tool calls is NOT delivered. ' +
                'To answer now, write a complete <message to="name">...</message> block or call the ' +
                '`send_message` tool.</system>'
            : '';
        const pushedId = pushToQuery(prompt + midTurnNote, extractAttachments(keep));
        if (admittedTurn && pushedId) admittedTurn.promptIds = [pushedId];
        archivePrompts.push({ prompt });
        admittedInbound = true;
        // NOT markCompleted here — see `pendingFollowUps`.
        pendingFollowUps.push({ ids: keptIds, promptId: pushedId });
        // No touchHeartbeat() here: it would restart the idle ceiling on every
        // inbound. Long silent tools are forgiven host-side (`decideStuckAction`).
      } catch (err) {
        pollFailed = true;
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Cross-mount corruption (see isCorruptionError): exit so host-sweep respawns a fresh mount.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        // Second continuation launch site: gates on observed idleness, since a
        // merged push corrupts the prompt ledger (see `turnIdle`).
        if (!admittedInbound && !pollFailed && turnIdle && !done && !endedForCommand) {
          maybeLaunchContinuation(true);
        }
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  /**
   * Busy scope across `result` HANDLING: between completing the batch and
   * pushing a corrective follow-up, every reaper term reads idle and a sweep
   * would kill the container. Idempotent; also closed in the outer `finally`, so
   * a throw cannot pin the container until the ceiling.
   */
  let resultScopeOpen = false;
  const openResultScope = (): void => {
    if (resultScopeOpen) return;
    resultScopeOpen = true;
    beginProviderBusyScope();
  };
  const closeResultScope = (): void => {
    if (!resultScopeOpen) return;
    resultScopeOpen = false;
    endProviderBusyScope();
  };

  /**
   * Lower the turn level unless the provider holds accepted-but-unstarted work:
   * a queuing provider (opencode) can reach `result` with a follow-up pending,
   * and publishing idle across that gap lets a sweep kill the container. Asks
   * the PROVIDER, not `archivePrompts`, whose phantom merged entries would pin
   * every Claude session busy.
   */
  const lowerTurnLevelUnlessQueued = (): void => {
    if (query.hasQueuedWork?.()) return;
    // A background agent launched this turn still runs inside the CLI after
    // `result`; lowering here lets the reaper kill it. The `background_work`
    // report re-runs this once that work is done.
    if (query.hasBackgroundWork?.()) return;
    setProviderTurnExecuting(false);
  };

  setProviderTurnExecuting(true);
  // Until its first event the host treats a new query as possibly hung at the gate.
  resetProviderQueryEvent();
  try {
    for await (const event of query.events) {
      if (event.type === 'error') {
        const err = new ProviderEventError(event);
        if (event.retryable) {
          // Don't abort: the SDK retries internally and a result usually follows.
          log(`Retryable upstream event (${event.message}) — continuing; SDK is retrying`);
          lastRetryableErr = err;
          continue;
        }
        // Report upward, never write here: the outer loop may recover in-turn,
        // and a write per attempt gives one fire several failure rows.
        notifyExchangeComplete(onExchangeComplete, {
          prompt: archivePrompts[0]?.prompt ?? initialPrompt,
          result: `Error: ${event.message}`,
          continuation: queryContinuation ?? initialContinuation,
          status: 'error',
        });
        requeueLedgerHead(true);
        throw err;
      }

      await handleEvent(event, routing);
      touchHeartbeat();
      try {
        markProviderQueryEvent();
      } catch (err) {
        log(`Failed to stamp provider_query_event_at: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
        // `init` also starts SDK-initiated turns nobody pushed. Mark them running,
        // or the reaper kills them mid-work and a continuation launch merges
        // into them. Only when `turnIdle` was still true: a pushed turn already
        // stamped the more accurate push-time clock.
        if (turnIdle) {
          turnIdle = false;
          turnStartedAtMs = Date.now();
        }
        setProviderTurnExecuting(true);
      } else if (event.type === 'result') {
        sawResult = true; // the SDK produced output → any prior api_retry recovered
        // Interim deliveries belong to the turn this result ends, even an empty
        // one, or they eat the next turn's identical block.
        const interimThisTurn = [...deliveredInterimBlocks];
        deliveredInterimBlocks.clear();
        const interimTaskBlocks = suppressedInterimTaskBlocks.splice(0);
        // A turn that consumed none of the runner's prompts (the CLI's synthetic
        // resume turn, a background-task notification) never answers a task
        // fire: recording it would take the fire's one outcome slot. Providers
        // without prompt ids leave every result eligible.
        const answersRunnerPrompt = event.answeredPrompts === undefined || event.answeredPrompts.length > 0;
        if (routing.taskRun && !answersRunnerPrompt) {
          log('Result answered no runner prompt (a turn the CLI started itself); not recorded as the task outcome');
        }
        if (routing.taskRun && event.answeredPrompts !== undefined && !answersRunnerPrompt) {
          const promptIds = openPromptIds();
          provisional =
            promptIds.length > 0
              ? { outcome: { text: event.text ?? '', isError: event.isError === true, model: modelInForce }, promptIds }
              : undefined;
        }
        // Set before handling, so any push it makes clears it again.
        turnIdle = true;
        // Published here, not around the call: the stream stays open after
        // `result`, so a flag cleared on return would keep the reaper off an
        // idle container. Lowers only the TURN level (a concurrent pre-task
        // script keeps its own scope); the result scope holds the bit across
        // the handling below.
        openResultScope();
        lowerTurnLevelUnlessQueued();
        // One turn_usage row per model per completed turn. Turn-level fields
        // are computed once, before any follow-up push resets turnStartedAtMs;
        // the shared turnId marks a multi-model turn's rows as one turn.
        const turnMeta = {
          turnId: randomUUID(),
          steps: event.steps ?? null,
          durationMs: Date.now() - turnStartedAtMs,
          trigger,
          rateLimitType: event.rateLimit?.type ?? null,
          rateLimitUtilization: event.rateLimit?.utilization ?? null,
          rateLimitResetsAt: event.rateLimit?.resetsAt ?? null,
        };
        // The continuation scopes running-total usage (toTurnDelta); without it
        // a new series' first turn is subtracted against the previous total.
        const usageScope = queryContinuation ?? initialContinuation ?? '';
        for (const usage of Array.isArray(event.usage) ? event.usage : [event.usage]) {
          recordTurnUsage(providerName, usage, turnMeta, usageScope);
        }
        // Do NOT set `done` here: the generator stays open for follow-up pushes
        // and polling gates on `done`, so it would starve every later trigger.
        // Complete the initial batch now so the sweep sees no stale claims
        // while the query stays open.
        markCompleted(initialBatchIds);
        // Only pushes this result CONSUMED; one still queued stays claimed.
        const answered = event.answeredPrompts;
        completeConsumedFollowUps(
          (f) => answered === undefined || f.promptId === undefined || answered.includes(f.promptId),
        );
        if (event.text) {
          // AUP refusal: the agent falls silent, and a spawned child would wait
          // 30 min for the parent's no-progress watchdog; emit spawn_failed so
          // the parent learns the real cause now.
          const aupRefusal = isAupRefusal(event.text);
          if (aupRefusal) {
            const taskId = getSessionSpawnTaskId();
            if (taskId !== null) {
              log(`AUP refusal detected — emitting spawn_failed for ${taskId}`);
              await writeMessageOut({
                id: generateId(),
                kind: 'system',
                content: JSON.stringify({
                  action: 'spawn_failed',
                  task_id: taskId,
                  fail_reason: 'aup_refusal',
                  summary:
                    "Anthropic's Usage Policy filter refused this task mid-stream. " +
                    'Retry as-is (filters are probabilistic), reword the brief to avoid trigger phrasing, ' +
                    'or do the task manually outside the spawn flow.',
                }),
              });
            }
          }
          // A mid-turn update is often repeated verbatim in the final text.
          const {
            sent,
            hasUnwrapped,
            taskBlocks: finalTaskBlocks,
          } = await dispatchResultText(event.text, routing, {
            alreadyDelivered: new Set(interimThisTurn),
          });
          const taskBlocks = [...interimTaskBlocks, ...finalTaskBlocks];
          const willRetryTaskBlocks =
            shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged) &&
            (!outcomeReportingEnabled() ||
              (!chatBudgetExhausted() &&
                !hasChatOutboundAfter(notificationWatermark, { channelType: null, platformId: null })));
          // With prompt ids a nudge's answer matches no fire, so only the id-less
          // path needs `taskBlockNudged` to keep it out of the next fire's slot.
          if (routing.taskRun && (event.answeredPrompts !== undefined || (!taskBlockNudged && answersRunnerPrompt)))
            await recordTaskTurn(
              { text: event.text, isError: event.isError === true, model: modelInForce },
              event.answeredPrompts,
            );
          if ((event.isError === true || aupRefusal) && !routing.taskRun) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            if (sent === 0) await deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0]?.prompt ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
            pauseAnsweredPrompt();
          } else {
            const outcomeReplyMissing =
              outcomeReportingEnabled() &&
              humanReplyOwed !== null &&
              answersRunnerPrompt &&
              !hasChatOutboundAfter(humanReplyOwed.sinceSeq, humanReplyOwed) &&
              !/^\s*<internal>\s*no reply\s*<\/internal>\s*$/i.test(event.text);
            const willNudgeOutcomeReply = outcomeReplyMissing && !unwrappedNudged;
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            if (willNudgeOutcomeReply) {
              unwrappedNudged = true;
              pushToQuery(OUTCOME_REPLY_NUDGE);
            }
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0]?.prompt ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped || willRetryTaskBlocks || outcomeReplyMissing ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              pushToQuery(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            if (willRetryTaskBlocks) {
              taskBlockNudged = true;
              const names = getAllDestinations()
                .map((d) => d.name)
                .join(', ');
              pushToQuery(buildTaskBlockNudge(taskBlocks, names));
            }
            // The wrapping-retry result answers the SAME user prompt — keep it
            // queued so the retry archives against it, not the nudge text.
            if (!willRetryWrapping && !willRetryTaskBlocks && !willNudgeOutcomeReply) {
              completeDeliveredPrompt();
            }
            // Settled when the person's conversation got a row, or the agent
            // deliberately sent nothing (<internal> only, or the one nudge is
            // spent). Blocks sent only ELSEWHERE leave it open, the same
            // question hasChatOutboundAfter answers for send_message.
            if (
              humanReplyOwed &&
              !willRetryWrapping &&
              !willNudgeOutcomeReply &&
              answersRunnerPrompt &&
              ((sent === 0 && !hasUnwrapped && !outcomeReplyMissing) ||
                hasChatOutboundAfter(humanReplyOwed.sinceSeq, humanReplyOwed))
            )
              humanReplyOwed = null;
          }
        } else {
          // A result with null text is still a fire; recording it lets a
          // recovery reset a stale failure streak.
          if (routing.taskRun && (event.answeredPrompts !== undefined || (!taskBlockNudged && answersRunnerPrompt))) {
            await recordTaskTurn(
              { text: '', isError: event.isError === true, model: modelInForce },
              event.answeredPrompts,
            );
          }
          // An empty result is NOT fine when a person is owed a reply and
          // nothing readable was written since: the wrapping nudge keys on
          // result text and misses an answer typed between tool calls. One
          // nudge per batch, shared with the wrapping retry.
          if (
            outcomeReportingEnabled() &&
            shouldNudgeTaskBlocks(routing.taskRun, interimTaskBlocks, taskBlockNudged) &&
            !chatBudgetExhausted() &&
            !hasChatOutboundAfter(notificationWatermark, { channelType: null, platformId: null })
          ) {
            taskBlockNudged = true;
            pushToQuery(
              buildTaskBlockNudge(
                interimTaskBlocks,
                getAllDestinations()
                  .map((d) => d.name)
                  .join(', '),
              ),
            );
          }
          const replyOwed =
            humanReplyOwed !== null &&
            answersRunnerPrompt &&
            event.isError !== true &&
            !hasChatOutboundAfter(humanReplyOwed.sinceSeq, humanReplyOwed);
          if (replyOwed && !unwrappedNudged) {
            unwrappedNudged = true;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            pushToQuery(
              outcomeReportingEnabled()
                ? OUTCOME_REPLY_NUDGE
                : `<system>Your turn ended without delivering anything to the person who wrote to you. Unwrapped text ` +
                    `written between tool calls is not delivered. Reply now in <message to="name">...</message> blocks ` +
                    `(destinations: ${names}), or, if no reply is warranted, answer with <internal>no reply</internal>.</system>`,
            );
            // Like the wrapping retry, the nudged result answers the SAME
            // prompt. A continuation at the ledger head still has to be paused.
            if (archivePrompts[0]?.continuationId) pauseAnsweredPrompt();
          } else {
            if (answersRunnerPrompt) humanReplyOwed = null;
            pauseAnsweredPrompt();
          }
        }
        // A provisional outcome stays only while a fire it could answer is open.
        if (provisional) {
          const stillOpen = openPromptIds();
          if (!provisional.promptIds.some((id) => stillOpen.includes(id))) provisional = undefined;
        }
        // Clear per result, not at emitTurnEnd (once per QUERY), or turn N+1
        // inherits turn N's figure. Safe here: this result's dispatches have run.
        clearContextTokens();
        // Same boundary for the roster, or it names workers a later turn never deployed.
        clearSubagents();
        // If handling pushed, the level stays raised; otherwise the container
        // becomes reapable here.
        closeResultScope();
      } else if (event.type === 'settled') {
        // The provider went idle holding prompts never seen answered, so their
        // echo was dropped; the last unmatched result consumed them.
        const settledIds = event.unansweredPrompts;
        completeConsumedFollowUps((f) => f.promptId !== undefined && settledIds.includes(f.promptId));
        if (routing.taskRun && provisional) {
          const held = provisional;
          const covered = event.unansweredPrompts.filter((id) => held.promptIds.includes(id));
          if (covered.length > 0) await recordTaskTurn(held.outcome, covered);
        }
        provisional = undefined;
        // `result` held the level while these looked queued; the turn is over now.
        lowerTurnLevelUnlessQueued();
      } else if (event.type === 'background_work') {
        // The CLI withholds this report until background agents and any turn
        // they start are done, so `live: 0` with no turn running is genuinely
        // idle. A mid-turn report changes nothing.
        if (event.live === 0 && turnIdle && !resultScopeOpen) lowerTurnLevelUnlessQueued();
      } else if (event.type === 'compacted') {
        advanceMemoryContextEpoch(providerName);
        // Compaction can drop the bootstrap and `<message to>` wrapping
        // discipline: re-inject the canonical index and capabilities before any
        // queued follow-up runs.
        const destinations = getAllDestinations();
        let reminder = '[system] Context was just compacted. Canonical memory and capabilities were refreshed.';
        if (destinations.length > 1) {
          const names = destinations.map((d) => d.name).join(', ');
          reminder +=
            ` Reminder: you have ${destinations.length} destinations (${names}). ` +
            (outcomeReportingEnabled()
              ? 'Use send_message with an explicit purpose to address them; omit to for the current conversation.'
              : 'Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.');
        }
        // Compaction can summarize the live task list away mid-run; hand it back.
        const listReminder = taskListEnabled()
          ? taskListReminder(loadTaskListState(getAgentMailbox().operations))
          : null;
        if (listReminder) reminder += `\n\n${listReminder}`;
        pushToQuery(ensureFreshContextBootstrap(reminder));
      } else if (event.type === 'interim_text') {
        for (const block of await dispatchInterimMessageBlocks(event.text, routing, (blocks) =>
          suppressedInterimTaskBlocks.push(...blocks),
        ))
          deliveredInterimBlocks.add(block);
      } else if (event.type === 'file') {
        await dispatchFileAttachment(event, routing);
      }
    }
    // Only retryable events and no result: the SDK's retries are exhausted.
    // Throw so the user sees a failure, not silence.
    if (!sawResult && lastRetryableErr) throw lastRetryableErr;
    requeueLedgerHead(true);
  } catch (err) {
    requeueLedgerHead(true);
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0]?.prompt ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    // Floor for the abort/throw paths, which never reach a `result`.
    closeResultScope();
    setProviderTurnExecuting(false);
    // The host must not read this ended query's first event as a live one's.
    try {
      resetProviderQueryEvent();
    } catch (err) {
      log(`Failed to reset provider_query_event_at: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Release, never complete, a push that was never consumed: completing loses
    // the message, and a claim kept across queries hides it until the container
    // exits. Bounded by FOLLOW_UP_MAX_RELEASES per container (it cannot bump the
    // host-written `tries`), so a poison follow-up is completed, not redelivered
    // forever.
    if (pendingFollowUps.length > 0) {
      const unconsumed = pendingFollowUps.flatMap((f) => f.ids);
      pendingFollowUps = [];
      const exhausted = unconsumed.filter((id) => (followUpReleaseCounts.get(id) ?? 0) >= FOLLOW_UP_MAX_RELEASES);
      const release = unconsumed.filter((id) => !exhausted.includes(id));
      try {
        if (release.length > 0) {
          releaseProcessingClaims(release);
          for (const id of release) followUpReleaseCounts.set(id, (followUpReleaseCounts.get(id) ?? 0) + 1);
          log(`Released ${release.length} follow-up claim(s) the stream ended without consuming`);
        }
        if (exhausted.length > 0) {
          markCompleted(exhausted);
          for (const id of exhausted) followUpReleaseCounts.delete(id);
          log(
            `Completed ${exhausted.length} follow-up(s) left unconsumed twice (${exhausted.join(', ')}) — ` +
              'not redelivering again',
          );
        }
      } catch (err) {
        log(`Failed to settle unconsumed follow-up claims: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { continuation: queryContinuation, taskTurns };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleEvent(event: ProviderEvent, routing: RoutingContext): Promise<void> {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      // Terminal errors must reach the user, or they see nothing until the
      // 30-min ceiling; retryable ones stay quiet. Quota with a declared
      // fallback is reported to the host instead (respawn on the fallback).
      if (event.retryable === false && event.classification === 'quota') {
        if (await reportProviderUnavailable(null, event.message, true, { resetAt: event.resetAt ?? null })) break;
      }
      if (event.retryable === false) {
        const chatText = `⚠️ Turn ended with an error: ${event.message}. I'll pick up from your next message.`;
        if (shouldPostInfraWarning(chatText)) {
          await writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: chatText }),
          });
        }
      }
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      // Internal MCP tool descriptions (`Using <tool>`) are not user progress.
      if (event.message.startsWith('Using ')) break;
      // quietStatus suppresses streaming status only; the final chat still goes out.
      if (routing.quietStatus) break;
      // The host edits the status line in place per session. The batch anchor
      // tells this turn's status from a prior turn's that ended without a
      // chat-final, so the host posts fresh instead of editing the stale 💭.
      const statusAnchor =
        routing.channelType && routing.platformId
          ? (getBatchAnchor(routing.channelType, routing.platformId) ?? routing.inReplyTo)
          : routing.inReplyTo;
      await writeMessageOut({
        id: generateId(),
        in_reply_to: statusAnchor,
        kind: 'status',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({
          text: event.message,
          ...(outcomeReportingEnabled() ? { reporting: { version: 1, purpose: 'progress' } } : {}),
        }),
      });
      break;
    case 'file':
      log(`File: ${event.path}`);
      break;
  }
}

export async function dispatchFileAttachment(
  file: { path: string; filename?: string; text?: string },
  routing: RoutingContext,
  outboxRoot = '/workspace/outbox',
): Promise<boolean> {
  let realPath: string;
  try {
    realPath = fs.realpathSync(file.path);
  } catch {
    log(`Generated file not found: ${file.path}`);
    return false;
  }

  if (!isAllowedFileEventPath(realPath)) {
    log(`Generated file outside allowed attachment paths: ${realPath}`);
    return false;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    log(`Generated file stat failed: ${realPath}`);
    return false;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > FILE_EVENT_MAX_BYTES) {
    log(`Generated file rejected: ${realPath} (${stat.size} bytes)`);
    return false;
  }

  const origin = findByRouting(routing.channelType, routing.platformId);
  const all = getAllDestinations();
  const dest = origin ?? (all.length === 1 ? all[0] : null);
  if (!dest) {
    log(`Generated file has no safe destination: ${realPath}`);
    return false;
  }

  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const destRouting = resolveDestinationThread(channelType, platformId);
  const id = generateId();
  const filename = sanitizeOutboundFilename(file.filename ?? path.basename(realPath));
  const outboxDir = path.join(outboxRoot, id);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(realPath, path.join(outboxDir, filename));

  await writeMessageOut({
    id,
    // Anchor to the CLAIMED batch, never the newest inbound row: that can be a
    // sibling task's future fire, and stamping it replied-to suppresses the series.
    in_reply_to: getBatchAnchor(channelType, platformId) ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? routing.threadId,
    content: JSON.stringify({ text: file.text ?? '', files: [filename] }),
  });
  return true;
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
async function deliverErrorResult(text: string, routing: RoutingContext): Promise<void> {
  log('Error result with no <message> envelope — delivering to channel');
  await writeMessageOut(
    withStatusSubtext({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      // Marked: the turn's own text to its own conversation is what the subtext
      // describes, and an error reply is when it matters most.
      agentReply: true,
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text }),
    }),
  );
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 *
 * Tolerates unclosed openers (the body runs to the next opener or end of
 * text), and strips stray wrapper markup so raw tags never reach users.
 */
const MESSAGE_OPENER_RE = /<message\s+to="([^"]*)"\s*>/g;
const MESSAGE_CLOSER = '</message>';
// Wrapper markup the parser could not pair (e.g. an empty `to=""`).
const STRAY_WRAPPER_RE = /<\/?message(?:\s+to="[^"]*")?\s*>/g;

export interface TaskMessageBlock {
  to: string;
  body: string;
}

const COMPLETE_MESSAGE_BLOCK_RE = /<message\s+to="[^"]+"\s*>[\s\S]*?<\/message>/g;
// Fenced and inline code: a block QUOTED in narration ("I'll answer with
// `<message to="here">…</message>` once the build finishes") is not a send.
const CODE_SPAN_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Deliver the complete `<message to="…">…</message>` blocks in text the agent
 * wrote mid-turn (ProviderEvent `interim_text`), and return the exact block
 * spans that were routed as addressed. Everything else in the text is
 * narration between tool calls and is dropped — `blocksOnly` keeps
 * dispatchResultText's origin fallback and wrapping verdict out of it; those
 * belong to the turn's FINAL text, which is the agent's answer. An unclosed
 * opener is left for the final text too; mid-turn is no place to guess where a
 * body ends. Routing, the `here` alias and peer recovery are
 * dispatchResultText's, so a block behaves the same wherever in the turn it
 * was written.
 *
 * A block whose destination does not resolve is simply not sent and not
 * returned, so the final text can still deliver it: destinations are read live
 * and can be added during a session (destinations.ts header) — e.g. by the
 * very tool call that follows this text. Task runs never deliver blocks
 * (RoutingContext.taskRun), so nothing is attempted there.
 */
export async function dispatchInterimMessageBlocks(
  text: string,
  routing: RoutingContext,
  onSuppressedTaskBlocks?: (blocks: TaskMessageBlock[]) => void,
): Promise<string[]> {
  if (routing.taskRun && !outcomeReportingEnabled()) return [];
  const delivered: string[] = [];
  // Mask, never delete: blanking only locates blocks, and each block is cut
  // from the original text, so code in its body stays byte-identical. A block
  // inside a code span has its opener blanked and never matches.
  const masked = text.replace(CODE_SPAN_RE, (span) => ' '.repeat(span.length));
  for (const m of masked.matchAll(COMPLETE_MESSAGE_BLOCK_RE)) {
    const block = text.slice(m.index, m.index + m[0].length);
    const { sent, taskBlocks } = await dispatchResultText(block, routing, { blocksOnly: true });
    if (taskBlocks.length) onSuppressedTaskBlocks?.(taskBlocks);
    if (sent > 0) delivered.push(block);
  }
  if (delivered.length > 0) log(`Interim text: ${delivered.length} <message> block(s) delivered before a tool call`);
  return delivered;
}

/**
 * Signal the turn boundary to the host.
 *
 * The host tracks the session's currently-visible 💭 status line and deletes it
 * when a chat-final supersedes it. Nothing supersedes a turn that ends without
 * one, so the label stands as the turn's only visible output — permanently in a
 * task session (inbox poller, scheduled job), which never gets a next turn whose
 * differing batch anchor would reset it.
 *
 * Emitted UNCONDITIONALLY: only the host knows whether a status is tracked, and
 * its handler is a no-op when none is.
 *
 * Called from every turn exit, BEFORE `checkpointTurnEnd` (seconds of git) and
 * `markCompleted`: inbound rows may not be completed yet when this row lands.
 */
async function emitTurnEnd(): Promise<void> {
  // Backstop for a query that ends without a result; the real clear is per result.
  clearContextTokens();
  clearSubagents();
  const lifecycleStatusId = getCurrentLifecycleStatus();
  await writeMessageOut({
    id: generateId(),
    kind: 'system',
    content: JSON.stringify({ action: 'turn_end', ...(lifecycleStatusId ? { lifecycleStatusId } : {}) }),
  });
  clearCurrentLifecycleStatus();
}

export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
  // `alreadyDelivered`: spans sent mid-turn. Not resent, but they still COUNT as
  // sent, or the narration around them hits the unwrapped fallback.
  // `blocksOnly`: mid-turn text; only blocks route, with no fallback or verdict.
  opts: { alreadyDelivered?: ReadonlySet<string>; blocksOnly?: boolean } = {},
): Promise<{ sent: number; hasUnwrapped: boolean; taskBlocks: TaskMessageBlock[] }> {
  type Opener = { index: number; endIndex: number; toName: string };
  const openers: Opener[] = [];
  MESSAGE_OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_OPENER_RE.exec(text)) !== null) {
    openers.push({ index: m.index, endIndex: MESSAGE_OPENER_RE.lastIndex, toName: m[1] });
  }

  if (outcomeReportingEnabled()) {
    // Keep every suppressed block durable, including task and mid-turn output.
    if (text.trim())
      await writeMessageOut({
        id: generateId(),
        kind: 'work_log',
        in_reply_to: routing.inReplyTo,
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text }),
      });
    const taskBlocks = routing.taskRun
      ? openers
          .map((opener, i) => {
            const next = openers[i + 1]?.index ?? text.length;
            const close = text.indexOf(MESSAGE_CLOSER, opener.endIndex);
            return {
              to: opener.toName,
              body: text.slice(opener.endIndex, close !== -1 && close <= next ? close : next).trim(),
            };
          })
          .filter((block) => block.to && block.body)
      : [];
    return { sent: 0, hasUnwrapped: false, taskBlocks };
  }

  let sent = 0;
  let cursor = 0;
  const taskBlocks: TaskMessageBlock[] = [];
  const scratchpadParts: string[] = [];

  for (let i = 0; i < openers.length; i++) {
    const opener = openers[i];
    if (opener.index > cursor) {
      scratchpadParts.push(text.slice(cursor, opener.index));
    }
    // Body endpoint precedence: explicit </message> before the next
    // opener wins; otherwise the next opener; otherwise end-of-text.
    const nextOpenerIdx = i + 1 < openers.length ? openers[i + 1].index : text.length;
    const explicitClose = text.indexOf(MESSAGE_CLOSER, opener.endIndex);
    const closeBeforeNext = explicitClose !== -1 && explicitClose <= nextOpenerIdx;
    const bodyEnd = closeBeforeNext ? explicitClose : nextOpenerIdx;
    const body = text.slice(opener.endIndex, bodyEnd).trim();
    cursor = closeBeforeNext ? explicitClose + MESSAGE_CLOSER.length : nextOpenerIdx;

    if (opts.alreadyDelivered?.has(text.slice(opener.index, cursor))) {
      sent++;
      continue;
    }
    const toName = opener.toName;
    if (!toName) {
      log(`Empty destination in <message to="">, dropping block`);
      if (body) scratchpadParts.push(body);
      continue;
    }
    if (routing.taskRun) {
      log(`Task run: <message to="${toName}"> block not delivered — task sessions send only via explicit tools`);
      scratchpadParts.push(
        `[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body });
      continue;
    }
    const dest = findByName(toName);
    if (!dest) {
      // A real destination named "here" wins over the alias (findByName ran first).
      if (toName.trim().toLowerCase() === 'here') {
        const origin = findByRouting(routing.channelType, routing.platformId);
        if (origin) {
          log(`to="here" resolved to origin "${origin.name}"`);
          await sendToDestination(origin, body, routing);
          sent++;
          continue;
        }
      }
      // Agents often address a PEER as a destination. Peers are reached by
      // @-mention, so route the body to the origin with `@<peer>` ensured.
      const peerName = findPeerName(toName);
      const originDest = peerName ? findByRouting(routing.channelType, routing.platformId) : undefined;
      if (peerName && originDest) {
        const mention = `@${peerName}`;
        const recoveredBody = body.toLowerCase().includes(mention.toLowerCase()) ? body : `${mention} ${body}`.trim();
        log(`Recovered peer-as-destination <message to="${toName}"> → channel "${originDest.name}" with ${mention}`);
        await sendToDestination(originDest, recoveredBody, routing);
        sent++;
        continue;
      }
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    const origin = findByRouting(routing.channelType, routing.platformId);
    if (origin && dest.name !== origin.name) {
      log(`Cross-destination final block: to="${toName}" from origin "${origin.name}"`);
    }
    await sendToDestination(dest, body, routing);
    sent++;
  }
  if (cursor < text.length) {
    scratchpadParts.push(text.slice(cursor));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join('').replace(STRAY_WRAPPER_RE, '')).trim();

  // Unwrapped-output fallback: route the cleaned scratchpad to the origin (or
  // the only destination when origin is unresolvable) instead of dropping the
  // reply. Self-wake turns are excluded: their unwrapped text is no-op
  // narration, and a wake with news posts via send_message.
  if (opts.blocksOnly) return { sent, hasUnwrapped: false, taskBlocks };

  if (!routing.taskRun && !routing.selfWake && sent === 0 && scratchpad) {
    const origin = findByRouting(routing.channelType, routing.platformId);
    if (origin) {
      await sendToDestination(origin, scratchpad, routing);
      log(`Origin-fallback: unwrapped text routed to "${origin.name}" (${scratchpad.length} chars)`);
      return { sent: 1, hasUnwrapped: false, taskBlocks };
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      await sendToDestination(all[0], scratchpad, routing);
      log(`Single-destination fallback: bare text routed to "${all[0].name}" (${scratchpad.length} chars)`);
      return { sent: 1, hasUnwrapped: false, taskBlocks };
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // In a task run, plain final text is the NORMAL ending (it becomes the run
  // log) — never treat it as an undelivered reply or nudge the agent to wrap it.
  const hasUnwrapped = !routing.taskRun && !routing.selfWake && sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, taskBlocks };
}

/**
 * Should this task-run result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns).
 */
export function shouldNudgeTaskBlocks(
  taskRun: boolean,
  taskBlocks: TaskMessageBlock[],
  alreadyNudged: boolean,
): boolean {
  return taskRun && taskBlocks.length > 0 && !alreadyNudged;
}

export function buildTaskBlockNudge(taskBlocks: TaskMessageBlock[], destinationNames: string): string {
  const blocks = taskBlocks
    .map(
      ({ to, body }) =>
        `<undelivered_message to="${escapePromptXml(to)}">${escapePromptXml(body)}</undelivered_message>`,
    )
    .join('\n');
  return (
    '<system>The final-output content below was not delivered from this task run:\n' +
    `${blocks}\n` +
    'If and only if any of it still needs to be sent, call send_message with an explicit to destination. ' +
    'If it was already sent or no notification is required, do not send it again. ' +
    (outcomeReportingEnabled()
      ? 'Use purpose="reply" for a requested answer or purpose="outcome" with the original supported workItem URL or harness request id only when the original work item finishes; evidence is optional. Routine progress stays internal; preserve required approval routes. '
      : '') +
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface FireOutcome {
  text: string;
  isError: boolean;
  model?: string;
}

/**
 * The single outcome a logical fire records. Nothing when not a task run, or
 * when DEFERRED (fallback, repository barrier): the same occurrence re-runs and
 * records its own, and two rows for one fire can page a human. A reported
 * outcome beats a synthesised one.
 */
export function resolveFireOutcome(input: {
  taskRun: boolean;
  deferredForRepositoryBarrier: boolean;
  deferredToFallback: boolean;
  reported?: FireOutcome;
  errorMessage?: string;
  model?: string;
}): FireOutcome | undefined {
  if (!input.taskRun) return undefined;
  if (input.deferredForRepositoryBarrier || input.deferredToFallback) return undefined;
  if (input.reported) return input.reported;
  if (input.errorMessage !== undefined) {
    return { text: `Error: ${input.errorMessage}`, isError: true, model: input.model };
  }
  return undefined;
}

/**
 * Task runs: the final text is the automatic run summary. Explicit
 * `ncl tasks append-log` calls are additive mid-run notes. Written as a
 * `task_log` outbound row; the host appends it to the series' tasks/<id>.md
 * with its usual timestamp stamp. Never delivered to anyone.
 *
 * `auto` marks the one-per-fire summary (only it counts toward a failure
 * streak); `isError` is the provider's verdict, which the result handler ignores
 * for task runs; `model` is what actually ran. An errored turn writes the row
 * even with empty text.
 */
export async function autoAppendTaskLog(
  text: string,
  isError = false,
  model?: string,
  taskMessageIds: string[] = [],
): Promise<void> {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  // No early return on empty text: every terminal fire must reach the outcome
  // ledger, and a blank success resets a stale failure streak.
  await writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    in_reply_to: taskMessageIds.length === 1 ? taskMessageIds[0] : null,
    content: JSON.stringify({
      text: line || (isError ? '(the provider reported an error and returned no text)' : '(run produced no output)'),
      auto: true,
      ...(taskMessageIds.length ? { taskMessageIds } : {}),
      ...(isError ? { isError: true } : {}),
      ...(model ? { model } : {}),
    }),
  });
  log(`Task run log auto-appended from final text${isError ? ' (provider flagged the turn an error)' : ''}`);
}

async function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): Promise<void> {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  // Only the own-conversation origin may inherit the session route (a freshly
  // bound dashboard has no stamp); a routed inbound, even channel-root null, wins.
  const ownConversation = channelType === routing.channelType && platformId === routing.platformId;
  const threadId = destRouting ? destRouting.threadId : ownConversation ? routing.threadId : null;
  // `send_message` bypasses this function (and is the default reply path), so it
  // stamps itself through the same withStatusSubtext.
  await writeMessageOut(
    withStatusSubtext({
      id: generateId(),
      // Batch anchor, never the channel's latest inbound row.
      in_reply_to: getBatchAnchor(channelType, platformId) ?? routing.inReplyTo,
      kind: 'chat',
      agentReply: true,
      platform_id: platformId,
      channel_type: channelType,
      thread_id: threadId,
      content: JSON.stringify({ text: body }),
    }),
  );
}

/**
 * Thread context of the most recent inbound on this channel+platform, or null.
 * Never its row id as in_reply_to: that row can be a sibling task's future
 * fire, and stamping it replied-to suppresses the series forever.
 */
function resolveDestinationThread(channelType: string, platformId: string): { threadId: string | null } | null {
  try {
    // The route's `inReplyTo` is deliberately dropped: thread context only.
    const route = getAgentMailbox().operations.getLatestInboundRoute(channelType, platformId);
    if (route) return { threadId: route.threadId };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timeout = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

// Mirror of FlagIntent in src/flag-parser.ts. Can't share a module across
// the host/container boundary (separate package trees).
interface FlagIntent {
  stickyModel?: string;
  turnModel?: string;
  clearStickyModel?: boolean;
  stickyEffort?: string;
  turnEffort?: string;
  clearStickyEffort?: boolean;
  stickyUltracode?: boolean;
  turnUltracode?: boolean;
  clearStickyUltracode?: boolean;
  stickyFast?: boolean;
  turnFast?: boolean;
}

// Chat budget (muteChat / chatLimit) is set before the provider runs and reset
// at every turn boundary. Not in applyFlagBatch, which also runs mid-turn: a
// follow-up without a task row must not clear an active mute.
export function applyChatBudget(messages: MessageInRow[]): void {
  let limit: number | null = null;
  for (const m of messages) {
    if (m.kind !== 'task') continue;
    try {
      const c = JSON.parse(m.content) as { muteChat?: boolean; chatLimit?: number };
      if (c.muteChat) {
        limit = 0;
        break;
      }
      if (typeof c.chatLimit === 'number' && Number.isFinite(c.chatLimit) && c.chatLimit >= 0) {
        limit = c.chatLimit;
      }
    } catch {
      // malformed content row
    }
  }
  setChatLimit(limit);
}

export function applyFlagBatch(
  messages: MessageInRow[],
  _routing: RoutingContext,
  providerName: string,
  options: { ignoreTaskFlagIntents?: boolean } = {},
): {
  model?: string;
  effort?: string;
  ultracode?: boolean;
  fast: boolean;
  ignoredModel?: string;
  /**
   * The ignored pin was typed in THIS batch. Only a fresh `-m` asks for the
   * primary back; a leftover sticky would ask on every turn.
   */
  ignoredModelWasExplicit?: boolean;
} {
  let intent: FlagIntent | undefined;
  for (const m of messages) {
    // Task rows carry per-fire flagIntent pins too.
    if (m.kind !== 'chat' && m.kind !== 'chat-sdk' && m.kind !== 'task') continue;
    // Scheduled pins were validated for the primary; under a fallback only its
    // own config picks the model.
    if (options.ignoreTaskFlagIntents && m.kind === 'task') continue;
    try {
      const parsed = JSON.parse(m.content) as { flagIntent?: FlagIntent };
      if (parsed.flagIntent) {
        intent = parsed.flagIntent;
        break;
      }
    } catch {
      // malformed content row
    }
  }

  if (intent) {
    if (intent.clearStickyModel) {
      clearStickyModel();
    } else if (intent.stickyModel) {
      setStickyModel(intent.stickyModel);
    }
    if (intent.clearStickyEffort) {
      clearStickyEffort();
    } else if (intent.stickyEffort) {
      setStickyEffort(intent.stickyEffort);
    }
    if (intent.clearStickyUltracode) {
      clearStickyUltracode();
    } else if (intent.stickyUltracode) {
      setStickyUltracode(true);
    } else if (intent.stickyEffort !== undefined) {
      // A plain effort change (stickyEffort set without the ultracode flag)
      // turns ultracode off — `-e high` after `-e ultracode` means plain high.
      clearStickyUltracode();
    }
    if (providerName === 'codex' && intent.stickyFast !== undefined) {
      setStickyFast(intent.stickyFast);
    }
  }

  const requestedModel = intent?.turnModel ?? getStickyModel();
  // Pins are validated against the PRIMARY provider and stickies persist, so
  // under a fallback a pin can name the other provider's model. Ignore it for
  // this provider only; the sticky stays, and `ignoredModel` says so once.
  const model =
    requestedModel !== undefined && !modelBelongsToProvider(requestedModel, providerName) ? undefined : requestedModel;
  const ignoredModel = model === requestedModel ? undefined : requestedModel;
  // Explicit only when this batch carried a `-m`; the stored sticky is not a fresh request.
  const ignoredModelWasExplicit =
    ignoredModel !== undefined && (intent?.turnModel !== undefined || intent?.stickyModel !== undefined);
  // Effort here is USER INTENT ONLY: defaults belong to each provider, since
  // only it knows the final model.
  const effort = intent?.turnEffort ?? getStickyEffort();
  const ultracode = intent?.turnUltracode ?? getStickyUltracode() ?? false;
  // Preserve a Codex sticky across provider migrations, but never let it
  // perturb a Claude/OpenCode query or trigger a false mid-turn restart there.
  const fast = providerName === 'codex' ? (intent?.turnFast ?? getStickyFast() ?? false) : false;

  return {
    model,
    effort,
    ultracode,
    fast,
    ...(ignoredModel !== undefined ? { ignoredModel, ignoredModelWasExplicit } : {}),
  };
}

/**
 * Ask the host to end this group's fallback window early (only the host writes
 * `provider_health`). It only clears the window; if the primary is still spent,
 * one failing turn re-records it.
 */
async function requestPrimaryProviderRetry(requestedModel: string): Promise<boolean> {
  // The claim is the loop brake: the respawned session re-reads the same pending
  // `-m` and would otherwise ask again forever.
  if (!claimPrimaryRetryRequest()) return false;
  try {
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'provider_retry_primary', requestedModel: requestedModel.slice(0, 200) }),
    });
    return true;
  } catch (err) {
    // Best-effort. The claim is deliberately NOT released: a write that may have
    // landed is no reason to ask again inside the cooldown.
    log(`Failed to request a primary-provider retry: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Only the router's typed-flag path stamps `flagAck`; task and support-thread
 * rows carry flagIntent without one.
 */
export function findAckedFlag(messages: MessageInRow[]): { row: MessageInRow; ack: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    try {
      const ack = (JSON.parse(messages[i].content) as { flagAck?: unknown }).flagAck;
      if (typeof ack === 'string' && ack.length > 0) return { row: messages[i], ack };
    } catch {
      // not JSON — no ack
    }
  }
  return undefined;
}

export function queuedSettingsNotice(ack: string): string {
  return `${ack} is queued until the current task finishes. Messages you send before then are read when it does.`;
}

/**
 * Once per cooldown. The pin stays stored: under a spawn-time fallback it
 * applies again when the primary returns; after a deliberate provider migration
 * the user must re-pin or clear it.
 */
export async function noteIgnoredModel(
  model: string,
  providerName: string,
  fallbackActive: boolean,
  routing: RoutingContext,
  explicit = false,
): Promise<void> {
  // A `-m` typed NOW while on a fallback asks for the primary back (the router
  // validated it against the primary). Gated on `explicit`: a sticky stored
  // before the outage would ask every turn and hold the group in a re-probe loop.
  const requestingPrimary = fallbackActive && explicit && (await requestPrimaryProviderRetry(model));
  const text =
    `⚙️ model pin ${model} is not a ${providerName} model — ignored while this session runs on ${providerName}; ` +
    (requestingPrimary
      ? `asking the host to return this session to its primary provider now.`
      : fallbackActive
        ? `it applies again when the primary provider is back.`
        : `set a ${providerName} model with -m <model>, or clear the pin with -m.`);
  log(text);
  if (!shouldPostInfraWarning(text)) return;
  await writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Said out loud: the reply came from a different model than the one pinned.
 * `cleared`: a sticky pin was retired (re-pin after reset); a one-off needs
 * nothing. `resetAt` renders in the install timezone, never raw ISO.
 */
export async function noteModelQuotaFallback(
  pinnedModel: string,
  cleared: boolean,
  err: unknown,
  routing: RoutingContext,
): Promise<void> {
  const resetAt = err instanceof ProviderEventError ? (err.event.resetAt ?? null) : null;
  const when = resetAt ? ` Its window resets ${formatLocalTime(resetAt, TIMEZONE)}.` : '';
  const text =
    `⚙️ ${pinnedModel} is out of quota — ran this turn on the group's default model instead.` +
    when +
    (cleared ? ` The pin is cleared; re-pin with \`-m ${pinnedModel}\` when you want it back.` : '');
  log(text);
  if (!shouldPostInfraWarning(text)) return;
  await writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Per-turn model/effort for a batch that OPENS a query. A pure task wake
 * SUPPRESSES the interactive sticky (`undefined` = no per-turn override, so the
 * group's configured model applies) rather than inherit a human's last `-m` in
 * the shared session; provider-neutral. Not for the live follow-up path, where
 * the batch may be a fragment of a human's turn. Wraps applyFlagBatch because
 * its sticky persistence must still happen.
 */
function effectiveTurnSettings(
  messages: MessageInRow[],
  routing: RoutingContext,
  providerName: string,
  ignoreTaskFlagIntents = false,
): {
  model?: string;
  effort?: string;
  ultracode?: boolean;
  fast: boolean;
  ignoredModel?: string;
  ignoredModelWasExplicit?: boolean;
} {
  const flagBatch = applyFlagBatch(messages, routing, providerName, { ignoreTaskFlagIntents });
  const task = taskWakeIntent(messages, ignoreTaskFlagIntents);
  if (!task.isPureTaskWake) return flagBatch;
  return {
    model: task.turnModel,
    effort: task.turnEffort,
    // Task pins cannot express ultracode (`validateTaskPin` refuses it), so a
    // sticky one is pure inheritance.
    ultracode: false,
    fast: flagBatch.fast,
  };
}

// A pure task wake (no interactive chat): returns the task's own pin so the
// caller suppresses the interactive sticky only when the task set none. Per
// BATCH, choosing a model; not processQuery's per-turn outcome keying, and the
// two must not be collapsed.
function taskWakeIntent(
  messages: MessageInRow[],
  ignoreTaskFlagIntents = false,
): {
  isPureTaskWake: boolean;
  turnModel?: string;
  turnEffort?: string;
} {
  let hasTask = false;
  let hasChat = false;
  // The FIRST pinned task wins with its axes TOGETHER, matching applyFlagBatch;
  // mixing axes across tasks synthesises a pair no one configured.
  let pin: FlagIntent | undefined;
  for (const m of messages) {
    if (m.kind === 'task') {
      hasTask = true;
      if (!ignoreTaskFlagIntents && !pin) {
        try {
          const fi = (JSON.parse(m.content) as { flagIntent?: FlagIntent }).flagIntent;
          if (fi) pin = fi;
        } catch {
          // malformed content row — treat as unpinned
        }
      }
    } else if (m.kind === 'chat' || m.kind === 'chat-sdk') {
      hasChat = true;
    }
  }
  return { isPureTaskWake: hasTask && !hasChat, turnModel: pin?.turnModel, turnEffort: pin?.turnEffort };
}
