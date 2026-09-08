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
import { writeMessageOut } from './db/messages-out.js';
import { getAgentMailbox } from './mailbox/index.js';
import { touchHeartbeat } from './heartbeat.js';
import { clearStaleProcessingAcks } from './db/container-state.js';
import {
  clearContinuation,
  clearCurrentInReplyTo,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentInReplyTo,
} from './db/session-state.js';
import {
  advanceMemoryContextEpoch,
  beginProviderBusyScope,
  classifyTrigger,
  clearDoneProposal,
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
  setProviderTurnExecuting,
  setStickyEffort,
  setStickyFast,
  setStickyModel,
  setStickyUltracode,
  shouldPostInfraWarning,
  type TurnTrigger,
} from './modules/mailbox/index.js';
import { clearBatchAnchors, getBatchAnchor, setCurrentBatchAnchors } from './current-batch.js';
import { formatCredentialRotationNotice } from './credential-rotation-notice.js';
import {
  formatMessages,
  extractAttachments,
  extractRouting,
  categorizeMessage,
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

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function resetProviderContext(providerName: string): void {
  clearContinuation(providerName);
  advanceMemoryContextEpoch(providerName);
}

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

// Transient server-overload backoff (provider.isTransientOverload — the Claude
// binary's "Server is temporarily limiting requests (not your usage limit)"
// after its own internal retries are spent). Retry the same prompt with capped,
// jittered exponential backoff. 30 tries × 30s cap ≈ 13 min worst case, well
// under host-sweep's 30-min idle ceiling (heartbeat is touched across each
// sleep). Full jitter is load-bearing: sibling containers hit the same overload
// in lockstep, so a fixed schedule would have them all retry on the same beat.
const TRANSIENT_OVERLOAD_MAX_TRIES = 30;
const TRANSIENT_OVERLOAD_BASE_MS = 1500;
const TRANSIENT_OVERLOAD_CAP_MS = 30_000;
const TRANSIENT_OVERLOAD_HEARTBEAT_MS = 10_000;

/** Capped exponential backoff with full jitter for retry attempt `n` (0-based). */
export function transientOverloadDelayMs(n: number, rand: number = Math.random()): number {
  const ceil = Math.min(TRANSIENT_OVERLOAD_CAP_MS, TRANSIENT_OVERLOAD_BASE_MS * 2 ** n);
  return Math.floor(ceil / 2 + rand * (ceil / 2));
}

/**
 * Credential rotation starts a fresh provider query, so its prompt is seen a
 * second time even though the inbound rows remain one unfinished batch. Keep
 * the original prompt intact after provenance that distinguishes this retry
 * from a new delivery without claiming the interrupted attempt had no effects.
 *
 * `rotation` is the result of the `rotateApiKey()` call (providers/claude.ts:2297)
 * that triggered this retry. When it reports `rotated: true` with a position/ringSize, a second
 * block tells the agent explicitly that its credential was swapped and any
 * "rate limited" narrative still sitting in its resumed transcript is stale
 * — see `formatCredentialRotationNotice`. Only this one call site (the
 * rotation retry) ever passes a rotation result; every other in-turn retry
 * (transient overload, stale session, context-too-long, …) keeps calling
 * `provider.query()` directly with the plain prompt, so the block never
 * appears for a retry that isn't actually a credential swap.
 */
function formatCredentialRetryPrompt(
  prompt: string,
  batch: MessageInRow[],
  rotation?: { rotated: boolean; position?: number; ringSize?: number },
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
    prompt
  );
}

// Codex idle-watchdog recovery (provider yields classification 'idle_timeout'
// after TURN_IDLE_TIMEOUT_MS — 5 min — of app-server silence). At a 5-min
// floor a fire almost certainly IS a real wedge (codex's normal slowness lives
// well under that), so retry only ONCE: a re-run rarely revives a 5-min stall,
// and each attempt costs another full ceiling, so more retries just make the
// user wait longer for the give-up. Short backoff — the watchdog already
// waited out 5 minutes of silence.
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
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
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

class ProviderEventError extends Error {
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

/**
 * A provider-level quota wall (exhausted account / weekly limit), as opposed
 * to a per-request rate limit. Nothing inside this container can recover it:
 * the credential itself is spent until the provider's window resets.
 */
function isProviderQuotaExhausted(err: unknown): boolean {
  return err instanceof ProviderEventError && err.classification === 'quota';
}

/**
 * Report an unusable provider to the host so later spawns route to the
 * declared fallback. Reporting only happens when a fallback exists — a group
 * that never opted in keeps its outage loud.
 *
 * Returns true when the caller must NOT write a chat error — which is
 * whenever a reroute is actually about to happen. The host respawns this
 * session on the fallback and the message is requeued, so the user gets a
 * real answer moments later; posting "I'll pick up from your next message"
 * first is both noise and a lie.
 *
 * The safety property lives in `alreadyOnFallback`: a container running AS
 * the fallback never suppresses, so at most ONE attempt is ever silent. A
 * genuine bug that breaks both providers still surfaces — one turn later,
 * having been tried on two runtimes instead of one.
 */
async function reportProviderUnavailable(
  providerName: string | null,
  message: string,
  recognizedQuota: boolean,
): Promise<boolean> {
  let runnerConfig: ReturnType<typeof getConfig>;
  try {
    runnerConfig = getConfig();
  } catch {
    // The production runner always loads config before polling. Keeping this
    // best-effort outage path non-throwing preserves visible errors for tests
    // and any future caller that invokes the event handler before bootstrap.
    return false;
  }
  const fallbackProvider = runnerConfig.providerFallback?.provider;
  if (!fallbackProvider) return false;
  const activeProvider = providerName ?? runnerConfig.provider;
  // Already running AS the fallback (the host set the spawn override) and the
  // fallback is spent too: there is nowhere left to route. Still record the
  // outage, but let the error reach the user — silently respawning here would
  // bounce between two dead providers forever.
  const alreadyOnFallback = Boolean(
    typeof process !== 'undefined' ? process.env?.NANOCLAW_PROVIDER_OVERRIDE : undefined,
  );
  try {
    await writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'provider_unavailable',
        provider: activeProvider,
        classification: recognizedQuota ? 'quota' : 'unavailable',
        message: message.slice(0, 500),
        fallbackProvider,
      }),
    });
    const suppress = !alreadyOnFallback;
    log(
      `Provider ${activeProvider} unusable (${recognizedQuota ? 'quota' : 'unrecovered failure'}); ` +
        `reported for fallback to ${fallbackProvider}${suppress ? ' — suppressing the chat error' : ''}`,
    );
    return suppress;
  } catch (err) {
    // Reporting is best-effort: if the outbound write fails we fall back to
    // the visible error rather than swallowing the failure silently.
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

// Exported for unit testing — the prefix set is the boundary for which
// agent-produced files get forwarded, so it is asserted directly.
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

/**
 * True when the model's final response text is Anthropic's standard AUP
 * refusal envelope. Match conservatively on BOTH anchor phrases (the
 * Claude Code prefix and the policy URL) — checking just one risks false
 * positives on legitimate prose discussing AUP, and Anthropic has
 * historically kept this exact message format stable.
 *
 * Exported for unit testing.
 */
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
  /** Optional dependency seam for deterministic turn-end checkpoint tests. */
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
    // Provider-idle admission boundary. Registered gates (the repository
    // ingress fence lives in modules/mailbox/admission.ts) decide whether this
    // container may start a turn; the loop itself knows nothing about them.
    if (evaluateAdmission()) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question).
    // Exception: recall_context system messages must reach the prompt path so the agent sees recalled facts.
    // isFirstPoll → getPendingMessages so on_wake rows only fire on the fresh container's first poll.
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

    // Accumulated trigger=0 context is idle from the agent's perspective: it
    // must not starve already-promised durable work. Leave those rows pending
    // so they still accompany the next real inbound turn.
    if (!hasTriggeringMessage) {
      const pending = getWorkContinuation();
      if (pending && !idleSuppressedContinuationIds.has(pending.id) && isWorkContinuationRunnable(pending, runnerId)) {
        // A fence can commit after the first outer-loop check and while the
        // pending batch is being read. Do not turn durable queued work into a
        // running provider turn once repository admission is closed.
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
          // Budget inherits from the continuation's SOURCE row: work promised
          // from a muted/capped task turn stays muted/capped when it resumes.
          // If the source row is gone (deleted task, legacy pending_next),
          // KEEP the current budget — an empty batch must not reset an
          // active mute/cap to unlimited.
          if (sourceBatch.length > 0) applyChatBudget(sourceBatch);
          const settings = applyFlagBatch([], routing, config.providerName);
          log(`Resuming durable continuation: ${runningWork.task.slice(0, 120)}`);
          config.provider.resetRotationCycle?.();
          setCurrentInReplyTo(routing.inReplyTo);
          setCurrentBatchAnchors(sourceBatch);
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
              // No representative inbound row to classify (the resumed
              // task's original trigger predates this turn) — the resume
              // itself IS the cause.
              'continuation',
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
          // processQuery tracks the turn itself. This tail does not: the
          // continuation record is already cleared, this path claims no
          // inbound rows, and the turn-end git checkpoint below is real work
          // the host would otherwise read as idle. Bounded, unlike the stream.
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
    //
    // Note on claim ordering: we used to markProcessing(ids) up front,
    // then run pre-task scripts. If a script gated all non-command rows,
    // any trigger=0 chat in the batch would stay 'processing' until the
    // host stale-claim sweep cleared it (~60s). Now we claim only the
    // rows that will actually reach the prompt — same pattern as the
    // in-turn helper.
    let normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        resetProviderContext(config.providerName);
        freshContextBootstrapRequired = true;
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

    // Command admission can remove X while recall-X was encountered earlier
    // in the same batch. Keep the pair invariant at the actual prompt
    // boundary: both rows survive, or neither does.
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

    // Re-validate post-script: if no admissible trigger survives, defer
    // the surviving trigger=0 context rows for the next iteration. Don't
    // claim them — leaving rows pending is the correct signal that they
    // weren't consumed. (Mirrors selectInTurnFollowUps' deferral logic.)
    if (!keep.some(isAdmissibleTrigger)) {
      log(
        `All ${normalMessages.length} non-command message(s) gated by script or no admissible trigger, skipping query`,
      );
      continue;
    }

    // Claim only the rows that will actually reach the prompt.
    // The barrier may have committed while scripts/settings were awaited.
    // Re-check at the final admission seam and acknowledge from this still-
    // provider-idle boundary rather than creating a new processing claim.
    if (evaluateAdmission()) continue;
    const keptIds = keep.map((m) => m.id);
    // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up):
    // classified once from the admitted batch and reused for every
    // processQuery call this turn makes, including its in-turn retries below
    // (same prompt/continuation, so the cause hasn't changed).
    const trigger = classifyTrigger(keep);
    markProcessing(keptIds);
    if (hasRealInbound(keep)) {
      resetWorkContinuationForRealInbound();
      // Real input means the thread is not finished after all — retract any
      // standing close proposal so the console never offers a close over work
      // that has since restarted. System rows (the close wrap-up request, the
      // ceiling notice) are not real inbound and deliberately leave it alone.
      clearDoneProposal();
      idleSuppressedContinuationIds.clear();
    }

    applyChatBudget(keep);
    const flagBatch = effectiveTurnSettings(keep, routing, config.providerName);
    const effectiveModel = flagBatch.model;
    const effectiveEffort = flagBatch.effort;
    const effectiveUltracode = flagBatch.ultracode;
    const effectiveFast = flagBatch.fast;

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const formattedPrompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);
    const prompt = freshContextBootstrapRequired ? ensureFreshContextBootstrap(formattedPrompt) : formattedPrompt;
    freshContextBootstrapRequired = false;

    log(
      `Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}` +
        (effectiveModel ? ` model=${effectiveModel}` : '') +
        (effectiveEffort ? ` effort=${effectiveEffort}` : '') +
        (config.providerName === 'codex' ? ` fast=${effectiveFast ? 'on' : 'off'}` : ''),
    );

    // Fresh credential-rotation cycle for this turn: the active token stays
    // sticky, but a since-healed credential (e.g. a reset session cap) is
    // reachable again. Without this, a turn that exhausted the ring could
    // never rotate again. (Incident 2026-06-25.)
    config.provider.resetRotationCycle?.();

    // Structured view of the same attachments `formatMessages` already
    // described inline, for a provider whose SDK takes real file parts. Every
    // retry below replays this batch, so it carries the same media.
    const batchAttachments = extractAttachments(keep);

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

    // Process the query while concurrently polling for new messages.
    // processingIds == keptIds now: commands were marked completed inline,
    // skipped task rows were marked completed by the pre-task block, and
    // we only claimed the rows that actually reach the prompt.
    const processingIds = keptIds;
    // Set when this batch is being handed to the fallback provider: the rows
    // must stay claimed-but-unfinished so the respawned container answers
    // them. Marking them completed would leave the reader with silence.
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
    // ONE logical fire, however many attempts it takes. `processQuery` is
    // re-invoked by the in-turn recovery paths below (credential rotation,
    // stale session, Codex idle, transient overload), and each call is a fresh
    // attempt at the SAME scheduled fire. The run-outcome ledger the escalation
    // sweep reads must see one row per fire: several failure rows would let a
    // fire that recovered push a series to the alert threshold, and a recovery
    // whose retries were all exhausted would otherwise write none at all
    // (that path throws past every result branch). Later attempts overwrite
    // earlier ones, so the value here is always the fire's FINAL result.
    //
    // INVARIANT: one admitted task turn produces exactly one outcome record.
    //
    // Keyed by the admitted task rows' ids, so a RETRY of a turn coalesces into
    // the same entry (the outer loop re-invokes `processQuery` with the same
    // batch) while a SEPARATE fire admitted into the same stream gets its own.
    // Insertion order is admission order.
    const fireOutcomes = new Map<string, FireOutcome>();
    const mergeTaskTurns = (turns: TaskTurnRecord[] | undefined): void => {
      for (const turn of turns ?? []) {
        if (turn.outcome) fireOutcomes.set(turn.key, turn.outcome);
      }
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
      );
      mergeTaskTurns(result.taskTurns);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);
      // The failed query's CLI child may still be running (an in-body throw
      // unwinds the generator without necessarily tearing the subprocess
      // down — see queryAbortController at providers/claude.ts:2506-2515). Every recovery branch
      // below starts a FRESH query on the same or a rotated credential, so
      // abort the old one first: left alone, it can keep running on an
      // exhausted/wedged credential and burn another failure minutes after
      // the replay is already healthy (observed 2026-09-08: a rotated retry
      // succeeded while the abandoned original hit a second 429 three
      // minutes later). Idempotent — a provider whose abort() already ran
      // (e.g. via config.signal) treats a second call as a no-op.
      query.abort();
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

      // Close the no-await seam immediately after processQuery returns. Each
      // retry branch re-checks at its own final query-admission point, which is
      // required for the backoff branches that may sleep while a fence lands.
      repositoryRecoveryAllowed();

      // Transient server-overload recovery: the provider's runtime hit a
      // 429/529 ("temporarily limiting requests · not your usage limit"),
      // exhausted its own internal retries, and surfaced the failure as result
      // text (Claude) — which the provider re-threw with a `transient_overload:`
      // marker. The credential is fine; the SERVER is busy. Rotating keys is
      // pointless (every key hits the same overloaded backend), so back off and
      // retry the SAME prompt+continuation in-turn, up to N times with a
      // growing jittered sleep. Touch the heartbeat across each sleep so the
      // host sweep doesn't kill the container as stale while we wait.
      const transient = config.provider.isTransientOverload?.(err) ?? false;
      if (transient && repositoryRecoveryAllowed()) {
        for (let attempt = 0; attempt < TRANSIENT_OVERLOAD_MAX_TRIES && !recovered; attempt++) {
          const sleepMs = transientOverloadDelayMs(attempt);
          log(
            `Transient server overload — retry ${attempt + 1}/${TRANSIENT_OVERLOAD_MAX_TRIES} ` +
              `in ${sleepMs}ms (same prompt, no rotation)`,
          );
          const beat = setInterval(touchHeartbeat, TRANSIENT_OVERLOAD_HEARTBEAT_MS);
          try {
            await new Promise((resolve) => setTimeout(resolve, sleepMs));
          } finally {
            clearInterval(beat);
          }
          touchHeartbeat();
          if (!repositoryRecoveryAllowed()) break;
          let retryQuery: AgentQuery | undefined;
          try {
            retryQuery = config.provider.query({
              prompt,
              attachments: batchAttachments,
              continuation,
              cwd: config.cwd,
              systemContext: config.systemContext,
              model: effectiveModel,
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
              continuation,
              { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
              runnerId,
              undefined,
              suppressContinuationUntilRealInbound,
              trigger,
            );
            mergeTaskTurns(retryResult.taskTurns);
            if (retryResult.continuation && retryResult.continuation !== continuation) {
              continuation = retryResult.continuation;
              setContinuation(config.providerName, continuation);
            }
            recovered = true;
          } catch (retryErr) {
            // Still overloaded → back off and try again. A *different* error
            // (the prompt/continuation didn't change, so context-too-long etc.
            // is essentially impossible mid-retry) → stop and surface the clean
            // exhausted message. ponytail: a quota-exhaustion appearing here
            // (overload clears, then the credential's cap is hit) does NOT
            // rotate this turn — but the next user message starts a fresh turn
            // that hits the normal rotation path, so it self-heals; not worth
            // threading retryErr through every downstream recovery branch.
            //
            // Either way this retryQuery's CLI child needs tearing down before
            // the next attempt (or before falling through to another recovery
            // branch) fires a new one — see the abort() call at the top of
            // this catch block for why an abandoned query can't be trusted to
            // clean up its own subprocess.
            retryQuery?.abort();
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

      // Codex idle-watchdog recovery: the codex-app-server went silent past
      // TURN_IDLE_TIMEOUT_MS and the provider classified the error
      // 'idle_timeout'. These stalls are transient (they recover on the next
      // user message), so retry the same prompt+continuation in-place instead
      // of dead-ending the user — the retry is functionally identical to the
      // "next message" that's already known to work. Bounded with a short
      // linear backoff; heartbeat touched across the sleep so host-sweep
      // doesn't reap the container mid-retry.
      const codexIdle = !recovered && err instanceof ProviderEventError && err.classification === 'idle_timeout';
      if (codexIdle && repositoryRecoveryAllowed()) {
        for (let attempt = 0; attempt < CODEX_IDLE_RETRY_MAX && !recovered; attempt++) {
          const sleepMs = CODEX_IDLE_RETRY_BASE_MS * (attempt + 1);
          log(`Codex idle-timeout — retry ${attempt + 1}/${CODEX_IDLE_RETRY_MAX} in ${sleepMs}ms`);
          const beat = setInterval(touchHeartbeat, TRANSIENT_OVERLOAD_HEARTBEAT_MS);
          try {
            await new Promise((resolve) => setTimeout(resolve, sleepMs));
          } finally {
            clearInterval(beat);
          }
          touchHeartbeat();
          if (!repositoryRecoveryAllowed()) break;
          try {
            const retryQuery = config.provider.query({
              prompt,
              attachments: batchAttachments,
              continuation,
              cwd: config.cwd,
              systemContext: config.systemContext,
              model: effectiveModel,
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
              continuation,
              { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
              runnerId,
              undefined,
              suppressContinuationUntilRealInbound,
              trigger,
            );
            mergeTaskTurns(retryResult.taskTurns);
            if (retryResult.continuation && retryResult.continuation !== continuation) {
              continuation = retryResult.continuation;
              setContinuation(config.providerName, continuation);
            }
            recovered = true;
          } catch (retryErr) {
            // Still stalled → back off and try again. Any other error → stop
            // and let the original idle error fall through to the clean message.
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

      // Retryable-upstream recovery: 429 / rate limit / overloaded /
      // upstream_error / subscription quota exhausted. If the provider has
      // fallback credentials configured (ANTHROPIC_API_KEY_N or
      // CLAUDE_CODE_OAUTH_TOKEN_N), rotate and retry once in-turn. Without
      // fallbacks OR once they're exhausted, fall through to the error
      // write. Ordered before isContextTooLong because prompt-too-long can
      // LOOK retryable in some error shapes, and the rotation cost is low.
      // Keep cycling the credential pool until one succeeds or the ring is
      // exhausted this turn. rotateApiKey is circular (wraps back to the
      // primary); it returns rotated:false once every other credential has
      // been tried this cycle, so the loop always terminates. Continuation is
      // preserved across rotations: the SDK's `resume:` reads a local .jsonl,
      // and the Anthropic API has no account-bound session object — the new
      // credential just signs the next request. (Incident 2026-06-25: a
      // single rotation could land on a spend-capped fallback and dead-end.)
      // `!transient`: a transient overload also matches isRetryable (its text
      // contains "Rate limited"), but rotation is the wrong cure — it was
      // already handled by the backoff loop above. Exclude it here.
      let rotation =
        !transient && !recovered && repositoryRecoveryAllowed() && config.provider.isRetryable?.(err)
          ? config.provider.rotateApiKey?.()
          : undefined;
      while (rotation?.rotated && !recovered) {
        log(`Upstream transient error — rotated credential, retrying same batch in-turn with provenance`);
        if (!repositoryRecoveryAllowed()) break;
        let retryQuery: AgentQuery | undefined;
        try {
          const retryPrompt = formatCredentialRetryPrompt(prompt, keep, rotation);
          retryQuery = config.provider.query({
            prompt: retryPrompt,
            attachments: batchAttachments,
            continuation,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
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
            continuation,
            { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
            runnerId,
            undefined,
            suppressContinuationUntilRealInbound,
            trigger,
          );
          mergeTaskTurns(retryResult.taskTurns);
          if (retryResult.continuation && retryResult.continuation !== continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after credential rotation also failed: ${retryMsg}`);
          // Tear this attempt's CLI child down before the next rotated
          // attempt (or the fall-through past this loop) starts a new one —
          // same reasoning as the abort() at the top of the outer catch.
          retryQuery?.abort();
          // Still retryable? Advance to the next credential in the ring and
          // retry again; rotateApiKey returns rotated:false when the cycle is
          // spent, ending the loop.
          rotation = config.provider.isRetryable?.(retryErr) ? config.provider.rotateApiKey?.() : undefined;
        }
      }

      // Context-window recovery: session grew past the model's limit.
      // Clear the continuation AND retry the same prompt once with a
      // fresh session, mirroring v1's silent prompt_too_long auto-
      // recovery (src/index.ts:2132-2199 — v1 also retried exactly once;
      // a second failure surfaced to the user same as we do here).
      //
      // Gated on `continuation` because a freshly-started session can't
      // be "too long" — if a user's first message is already over the
      // limit (e.g. a huge paste), the error falls through to the
      // isSessionInvalid branch (no retry) and lands as an error chat.
      // Not ideal for that edge case, but the alternative (retrying
      // without continuation) is what we'd do anyway, and the chat-error
      // pattern makes the failure explicit to the user.
      //
      // Recap from the per-session DB tells the agent what was just
      // discussed so it doesn't lose the thread. The marker is for the
      // case where there's no recap (no completed messages yet).
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
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            attachments: batchAttachments,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
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
            undefined,
            { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
            runnerId,
            undefined,
            suppressContinuationUntilRealInbound,
            trigger,
          );
          mergeTaskTurns(retryResult.taskTurns);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after context-too-long also failed: ${retryMsg}`);
          // The failed retry's `init` event may have re-persisted a
          // continuation. Clear it again so the next turn starts clean.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      } else if (!recovered && repositoryRecoveryAllowed() && continuation && config.provider.isSessionInvalid(err)) {
        // Stale/corrupt continuation — most often a transcript .jsonl
        // that got pruned out from under us, or a session id that was
        // valid in a prior container but doesn't exist in this one's
        // ~/.claude/projects/. Clear and retry once with a recap from
        // the per-session DB so the user doesn't have to re-send and
        // doesn't lose conversational context.
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
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            attachments: batchAttachments,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
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
            undefined,
            { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
            runnerId,
            undefined,
            suppressContinuationUntilRealInbound,
            trigger,
          );
          mergeTaskTurns(retryResult.taskTurns);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after stale-session recovery also failed: ${retryMsg}`);
          // The failed retry's `init` event may have re-persisted a
          // continuation. Clear it again so the next turn starts clean.
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // Codex can yield a terminal thread/status systemError as a ProviderEvent
      // instead of throwing. That means it bypasses the stale-session catch path
      // above unless we handle it here. With a stored continuation, a Codex
      // thread in systemError is poison: the next support-poller recurrence
      // resumes the same dead thread and posts the same warning every 15 min.
      // Clear once and retry fresh with a recap, mirroring stale-session
      // recovery. If the fresh thread also fails, surface that final error.
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
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            attachments: batchAttachments,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
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
            undefined,
            { model: effectiveModel, effort: effectiveEffort, ultracode: effectiveUltracode, fast: effectiveFast },
            runnerId,
            undefined,
            suppressContinuationUntilRealInbound,
            trigger,
          );
          mergeTaskTurns(retryResult.taskTurns);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after provider system_error also failed: ${retryMsg}`);
          continuation = undefined;
          clearContinuation(config.providerName);
        }
      }

      // A spent provider account is not a turn failure the user can act on.
      // When a fallback is declared, report it and stay silent: the host
      // respawns this session on the fallback and the requeued message is
      // answered there, so the conversation shows a slow reply rather than
      // an error the reader can do nothing about.
      // Ask the provider first — it knows its own error vocabulary and
      // surfaces quota in more than one shape. Fall back to the classified
      // event form for providers that don't implement the hook.
      const quotaExhausted = config.provider.isQuotaExhausted?.(err) ?? isProviderQuotaExhausted(err);
      // Any failure the in-turn recovery could not fix means this provider is
      // not currently usable for this group — a spent account, a wedged
      // app-server, a dead credential. Record it either way so the next spawn
      // routes to the fallback; only a recognized quota also silences the
      // chat error.
      // Every attempt threw — including the "stream ended with only retryable
      // events" path, which rethrows past every result branch. Recorded as a
      // message only; the decision to WRITE it belongs to the `finally`, because
      // `deferredToFallback` is not known until a few lines below this point.
      if (fireOutcomes.size === 0) fireErrorMessage = errMsg;
      if (deferredForRepositoryBarrier) releaseProcessingClaims(processingIds);
      const quotaHandled =
        !recovered &&
        !deferredForRepositoryBarrier &&
        (await reportProviderUnavailable(
          config.providerName,
          err instanceof Error ? err.message : String(err),
          quotaExhausted,
        ));
      deferredToFallback = quotaHandled;

      // Only surface the error to the user if we couldn't recover inline.
      if (!recovered && !quotaHandled && !deferredForRepositoryBarrier) {
        // Deliberately un-gated: an unclassified error can be a real bug, not
        // a flapping provider, and shouldn't be silently swallowed by dedupe.
        const providerEventErr = err instanceof ProviderEventError && err.retryable === false;
        const isInfraWarning = transient || codexIdle || providerEventErr;
        const chatText = transient
          ? `⚠️ Anthropic's API stayed overloaded across ${TRANSIENT_OVERLOAD_MAX_TRIES} retries — I couldn't finish this turn. I'll pick up from your next message.`
          : codexIdle
            ? `⚠️ The Codex app-server stalled across ${CODEX_IDLE_RETRY_MAX} retries — I couldn't finish this turn. I'll pick up from your next message.`
            : providerEventErr
              ? `⚠️ Turn ended with an error: ${err.message}. I'll pick up from your next message.`
              : `Error: ${errMsg}`;
        // `log(\`Query error: ${errMsg}\`)` above already covers unconditional
        // logging for this whole branch — the dedupe below only gates the
        // channel post, and only for the classified infra/provider notices.
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
      // The fire is over — success, recovered success, or exhausted failure —
      // so this is the one place that knows its final result AND whether the
      // batch was deferred. Exactly one `task_log` row per fire: one run-log
      // line, one ledger outcome.
      //
      // A DEFERRED batch is not a fire that ended. Both the repository-barrier
      // and provider-fallback paths deliberately leave or release the claim so
      // the SAME occurrence runs again, and that re-run records its own outcome.
      // Writing here as well would give one fire two failures — enough for two
      // occurrences to trip a threshold set at three, paging a human about a
      // task that was merely postponed. `deferredToFallback` is only assigned
      // after the catch's synthesis point, which is why this decision lives
      // here and not there.
      //
      // Best-effort; a bookkeeping write must never mask the turn's own error.
      // Flush ONE record per admitted task turn, in admission order. A turn
      // with no outcome and no error to synthesise from records nothing; a
      // deferred batch records nothing at all, because the same occurrence runs
      // again and that re-run records its own.
      {
        const flush: Array<[string, FireOutcome | undefined]> =
          fireOutcomes.size > 0 ? [...fireOutcomes.entries()] : [[initialTurnKey, undefined]];
        for (const [, reported] of flush) {
          const outcome = resolveFireOutcome({
            taskRun: routing.taskRun === true,
            deferredForRepositoryBarrier,
            deferredToFallback,
            reported,
            errorMessage: fireErrorMessage,
            model: effectiveModel,
          });
          if (!outcome) continue;
          try {
            await autoAppendTaskLog(outcome.text, outcome.isError, outcome.model);
          } catch (logErr) {
            log(`Could not record task run outcome: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
          }
        }
      }
      if (abortActiveQuery) config.signal?.removeEventListener('abort', abortActiveQuery);
      // Always clear the per-batch in_reply_to so MCP tools don't stamp
      // stale routing on the next turn (a2a return-path safety).
      clearCurrentInReplyTo();
      clearBatchAnchors();
    }

    // Same bracket as the durable-continuation tail above, for the same
    // reason: processQuery lowered the turn level at `result`, the batch was
    // completed there too, and the git checkpoint below is real work the host
    // would otherwise read as idle. Bounded, so it cannot pin the container.
    beginProviderBusyScope();
    try {
      await emitTurnEnd();

      // Compatibility callback is intentionally non-mutating in production.
      // Sibling agents share this topic checkout, so turn-end code must never
      // stage, commit, reset, or remove another sibling's live index lock.
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

/**
 * Predicate for "this row is a real wake trigger" — non-system, trigger=1,
 * not a /clear chat command. Used by both the in-turn admission helper and
 * the post-pre-task re-validation step.
 */
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

/**
 * Preserve complete host recall pairs across a later admission step. The
 * original batch defines which pairs existed; if command handling or a
 * pre-task gate removes either member, the survivor is removed too.
 */
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
 * Decide which pending rows to admit as a mid-turn follow-up push to an
 * in-flight query. Pure function — no DB writes — so tests can exercise
 * it directly without spinning a poll loop.
 *
 * Rules:
 * - Defer entirely (return []) when no row would survive admission as a
 *   real wake trigger. Survivors are trigger=1 chat/chat-sdk that aren't
 *   /clear, plus trigger=1 of other non-system kinds (task, webhook).
 *   /clear and non-recall system rows are NOT real triggers — letting
 *   them gate ride-along would push trigger=0 context with no actual
 *   user message in the prompt.
 * - When at least one survivor exists, admit:
 *     - chat / chat-sdk (any trigger; formatter wraps trigger=0 in
 *       <thread_context>; /clear excluded)
 *     - non-system other kinds, trigger=1 only
 *     - recall_context system rows whose paired trigger id is in the
 *       surviving-triggers set
 * - All other system rows are dropped.
 */
export function selectInTurnFollowUps(allPending: MessageInRow[]): MessageInRow[] {
  const completePending = retainCompleteRecallUnits(allPending);
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

// Invariant: the `recall-` prefix is reserved for the host-side paired write in
// `src/session-manager.ts` (`buildRecallRow`/`writeSessionMessageInternal`).
// Platform message ids written by router.ts always carry the shape
// `<platform-baseId>:<agentGroupId>`; no
// adapter produces baseIds starting with `recall-`, so the strip below
// cannot collide with a real inbound id. Keep this contract — adding an
// adapter that breaks it would silently corrupt recall pairing.

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

/** What one ATTEMPT produced. An attempt can carry SEVERAL admitted task turns. */
interface QueryResult {
  continuation?: string;
  /**
   * One entry per task turn admitted into this attempt, in admission order,
   * each with the terminal result that answered it (absent if none did).
   *
   * A list, not a slot. A long-lived stream admits later task rows mid-turn,
   * so one `processQuery` call can carry several fires; a single slot recorded
   * the first and silently dropped the rest. `key` is the admitted task rows'
   * ids, which is stable across retries OF THAT TURN and distinct between
   * fires — so the caller coalesces retries and keeps separate fires separate.
   */
  taskTurns?: TaskTurnRecord[];
}

/** One admitted task turn and the outcome that answered it. */
export interface TaskTurnRecord {
  key: string;
  outcome?: FireOutcome;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  // The model/effort/ultracode/fast settings this query was created with. The follow-up
  // handler compares the current effective values against these to detect a
  // mid-turn change (flag OR change_model) and end-and-reopen on the new model.
  querySettings: { model?: string; effort?: string; ultracode?: boolean; fast?: boolean },
  runnerId: string = randomUUID(),
  initialContinuationId?: string,
  onContinuationPaused?: (id: string) => void,
  // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up): what
  // caused the batch that started THIS processQuery call. Applied to every
  // `result` event this call produces, including any later follow-up admitted
  // mid-stream or durable continuation launched via maybeLaunchContinuation —
  // the stream has no cheaper way to reclassify mid-flight, and a turn that
  // changes cause partway through is rare enough that merging it into the
  // call's original trigger beats fabricating a per-event reclassification.
  trigger: TurnTrigger = 'unknown',
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  let taskBlockNudged = false;
  // Retryable (e.g. SDK `api_retry`) events are the SDK's own mid-stream retry
  // signal, NOT a turn-ending error. Record the last one but keep consuming so
  // the SDK's internal retry can still produce a result; only surface it if the
  // stream ends without ever yielding one. (2026-06-26: throwing on the first
  // api_retry dead-turned long ultracode turns with a bogus "Error: API retry".)
  let sawResult = false;
  let lastRetryableErr: ProviderEventError | undefined;
  // The model actually in force. `querySettings` is the snapshot this query was
  // OPENED with and never changes; a follow-up wake with a new pin applies
  // `fb.model` through `query.applySettings` and keeps the same stream, so the
  // snapshot goes stale mid-turn. An escalation that named the snapshot would
  // diagnose the OLD pin as the failing model, which is the one fact the alert
  // exists to get right (Codex round 2).
  // Attribution reads the PROVIDER's resolved model, never what was requested.
  // `querySettings.model` is undefined for an unpinned pure task fire — that
  // absence means "the group default", and only the provider can say what it
  // resolved to. Recording the request wrote NULL to task_run_outcomes for
  // exactly the fires this change reroutes.
  let modelInForce = query.resolvedModel ?? querySettings.model;
  /**
   * What the live stream is ACTUALLY set to. `querySettings` is the immutable
   * creation snapshot, so once a live settings change lands it stops
   * describing the stream — and comparing the next batch against it makes a
   * genuine change look like no change. Concretely: a task fire applies its
   * settings live, then chat arrives whose sticky values happen to equal the
   * stale creation snapshot, the comparison says "unchanged", applySettings is
   * skipped, and the human's turn silently inherits the TASK's effort and
   * ultracode. That is this PR's own bug pointed the other way, so the
   * baseline has to move with the stream.
   */
  let liveSettings: { model?: string; effort?: string; ultracode?: boolean; fast?: boolean } = { ...querySettings };
  /**
   * One slot per ADMITTED TASK TURN, in admission order — the invariant this
   * whole path exists to hold: *one admitted task turn produces exactly one
   * outcome record*.
   *
   * Reported up rather than written here, because one `processQuery` call is
   * one ATTEMPT, not one fire — the outer loop re-invokes it for in-turn
   * recovery, so only the caller knows which attempt was final.
   */
  const taskTurns: TaskTurnRecord[] = [];
  if (routing.taskRun && initialBatchIds.length > 0) {
    taskTurns.push({ key: initialBatchIds.join(',') });
  }
  /**
   * Fill the OLDEST unanswered turn, matching the documented stream semantics
   * that "each result event consumes the oldest unanswered prompt". When every
   * turn is already answered the result is an in-stream nudge/wrapping retry of
   * the turn that just closed, and is deliberately dropped: coalescing is
   * scoped to retries OF a turn, never across turns.
   */
  const recordTaskTurn = (outcome: FireOutcome): void => {
    const open = taskTurns.find((t) => !t.outcome);
    if (open) open.outcome = outcome;
  };
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  interface PromptLedgerEntry {
    prompt: string;
    continuationId?: string;
  }
  const archivePrompts: PromptLedgerEntry[] = [
    { prompt: initialPrompt, ...(initialContinuationId ? { continuationId: initialContinuationId } : {}) },
  ];

  const requeueLedgerHead = (suppress: boolean): void => {
    const continuationId = archivePrompts[0]?.continuationId;
    if (!continuationId) return;
    requeueWorkContinuationIfMatches(continuationId, runnerId);
    if (suppress) onContinuationPaused?.(continuationId);
  };

  // Whether the provider is between turns. A `result` event says it is; every
  // push into the stream says it isn't. This is the launch gate the ledger
  // below cannot be: when the SDK MERGES a mid-turn push into the running turn
  // it emits ONE result for TWO ledger entries, so `archivePrompts` over-counts
  // from then on and its "FIFO is empty" gate never opens again. Observed in
  // production 2026-08-16 — a queued continuation sat stranded for 52 minutes
  // until the idle ceiling killed the container.
  let turnIdle = false;
  // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up): wall
  // time from the prompt that starts a turn to the `result` event that
  // answers it. Reset at the same choke point as `turnIdle` above, so every
  // real push (initial batch, in-turn follow-up, durable continuation
  // launch) restarts the clock for the turn it starts.
  let turnStartedAtMs = Date.now();
  const pushToQuery = (message: string, attachments?: PromptAttachment[]): void => {
    turnIdle = false;
    // Same boundary as `turnIdle`, published for the host. A pushed turn runs
    // with no processing claim of its own (the initial batch was completed at
    // the previous `result`), so this is the only thing standing between it
    // and the idle reaper.
    setProviderTurnExecuting(true);
    turnStartedAtMs = Date.now();
    query.push(message, attachments);
  };

  const pauseAnsweredPrompt = (): void => {
    requeueLedgerHead(true);
    archivePrompts.shift();
  };

  /**
   * Launch the queued durable continuation, if any. `ignoreLedger` is set by
   * the poll tick, which has already established provider idleness first-hand
   * (turnIdle) and confirmed it had no real inbound of its own to admit.
   * Double-launch is impossible either way: markWorkContinuationRunning is a
   * transactional single-flight claim on the record id.
   */
  const maybeLaunchContinuation = (ignoreLedger: boolean): void => {
    // Real inbounds already queued in the stream take priority. Their result
    // will revisit this function; only launch durable work when the prompt FIFO
    // is otherwise empty. This lets an explicit user stop cancel the record
    // before its prompt is ever pushed.
    if (!ignoreLedger && archivePrompts.length > 0) return;
    if (getActiveRepositoryMountBarrier() !== null) return;
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
  // Slash commands push the active stream toward end-of-turn so the outer loop
  // can dispatch them through the canonical command path. Once we've decided to
  // end, gate further polling so we don't reclaim the rows mid-teardown.
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      // Set when this tick pushed a real inbound (which outranks durable work)
      // and when it failed outright — both suppress the continuation launch at
      // the bottom.
      let admittedInbound = false;
      let pollFailed = false;
      try {
        const repositoryBarrier = getActiveRepositoryMountBarrier();
        if (repositoryBarrier !== null) {
          // Stop accepting follow-ups and let the current provider turn/tool
          // finish. The outer loop acknowledges only after processQuery has
          // returned, which proves this active query is fully drained.
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

        // Flag-bearing messages (-m/-e/-f) are handled after admission, below:
        // stickies are persisted and live-capable settings are applied via
        // provider control requests (query.applySettings). Ending the stream
        // is the fallback when the provider has no live controls, the
        // combination can't be expressed, or Codex's app-server-scoped fast
        // service tier changed.

        // Filtering on thread_id here caused deadlocks when the initial batch
        // and follow-ups had mismatched thread_ids (e.g. a host-generated welcome
        // trigger with null thread vs a Discord DM reply); per-thread sessions
        // already isolate threads, so the router's routing is sufficient.
        //
        // Admission rules live in selectInTurnFollowUps so they can be unit-
        // tested. Defers (returns []) when no admissible trigger=1 row is
        // present in the snapshot; otherwise admits accumulated trigger=0
        // chat context plus paired recall_context. The helper also drops
        // system rows except recall_context, replacing the older `kind !==
        // 'system'` filter from upstream's poll-loop.
        const candidates = selectInTurnFollowUps(allPending);
        if (candidates.length === 0) return;

        // Run pre-task scripts BEFORE claiming rows. A scripted task with
        // wakeAgent=false can drop the only admissible trigger from the
        // batch; if we'd already markProcessing'd the trigger=0 chat
        // context, those rows would be hidden behind processing acks even
        // though they were never sent to the agent. Deferring the claim
        // lets us walk away cleanly when no real trigger survives.
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(candidates);
        const keep: MessageInRow[] = retainCompleteRecallPairs(candidates, preTask.keep);
        const skipped = preTask.skipped;
        // MODULE-HOOK:scheduling-pre-task-followup:end

        // Re-validate post-script: if the only admissible trigger was a
        // task that the script gated, keep would be trigger=0 chat (and
        // possibly orphaned recall_context). Don't push context-only into
        // an active stream — defer it for the next real wake. Skipped task
        // IDs still get marked completed so the script is not re-run.
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

        // Settings change since this query was created — from a flag
        // row OR a mid-turn change_model tool call (which writes sticky_model
        // directly, with NO flag row). applyFlagBatch persists any flag stickies
        // (previously this never ran on the follow-up path, so flags were acked
        // by the host then silently dropped; observed live 2026-06-10) AND
        // re-reads the current effective model/effort — idempotent on a no-flag
        // batch — so comparing it to the query's creation values catches BOTH
        // paths. (Previously gated on hasFlagIntent, so a change_model sticky
        // write was silently pushed into the old-model stream — Codex P1.) A
        // provider without live controls (opencode/codex) ends the stream so the
        // outer loop reopens on the new model, leaving these rows pending; one
        // with live controls (claude) applies it in place, same stream.
        // applyFlagBatch, NOT effectiveTurnSettings — deliberately, and this is
        // the one place scheduled-task suppression does NOT apply.
        //
        // `keep` here is the newly-admitted SUB-BATCH, not the turn. A task row
        // becoming due while an interactive query is still streaming makes
        // `keep` a lone task row, so `isPureTaskWake` is true — but the turn it
        // would retarget may be a human's, mid-answer. Suppressing here moved
        // someone's in-progress work off their own model and effort: the exact
        // inverse of the bug this file's suppression exists to prevent.
        //
        // `isPureTaskWake` is not the wrong IDEA here, it is the wrong
        // QUESTION. It answers "is this batch a task wake"; deciding whether to
        // retarget a running turn needs to know whether that TURN is idle, and
        // a fragment of a turn cannot say. Doing it properly needs turn-level
        // state, which is new machinery on a seam that has already failed
        // twice — see the follow-up issue linked from CHANGELOG.
        //
        // So the pre-existing behaviour stands: a task occurrence joining a
        // running stream inherits that stream's settings. Documented as a known
        // limitation rather than left for someone to rediscover.
        const fb = applyFlagBatch(keep, extractRouting(keep), providerName);
        const liveSettingsChanged =
          fb.model !== liveSettings.model ||
          fb.effort !== liveSettings.effort ||
          fb.ultracode !== liveSettings.ultracode;
        const fastChanged = fb.fast !== (liveSettings.fast ?? false);
        if (liveSettingsChanged || fastChanged) {
          // Codex fast mode is selected when its app-server starts. Even if a
          // provider supports live model/effort controls, a tier change must
          // end this query so the outer loop can respawn with new overrides.
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
            // Same read as at creation — one source, so a retarget and an open
            // cannot disagree about what ran.
            modelInForce = query.resolvedModel ?? fb.model;
            // The stream has moved; the comparison baseline moves with it, or
            // the next batch is measured against a snapshot that no longer
            // describes anything.
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
          // The await above widens the done-race window — re-check before
          // claiming so rows aren't marked processing against a dead stream.
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
        // Refresh the per-batch in_reply_to so MCP send_message stamps
        // outbound rows with the follow-up batch's anchor, not the outer
        // turn's. Without this, an a2a inbound pushed mid-turn has its
        // reply routed back to the outer-turn source session, which can
        // be a different session in a different mg.
        const followUpRouting = extractRouting(keep);
        setCurrentInReplyTo(followUpRouting.inReplyTo);
        setCurrentBatchAnchors(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        taskBlockNudged = false;
        // A later occurrence joining this stream is a SEPARATE fire and needs
        // its own outcome slot. Without this it answered into the first fire's
        // slot — or, once that was filled, vanished — so a frequently failing
        // series could sit below the escalation threshold forever, which is
        // precisely the outcome this feature exists to prevent.
        if (routing.taskRun) {
          const admittedTaskIds = keep.filter((m) => m.kind === 'task').map((m) => m.id);
          if (admittedTaskIds.length > 0) taskTurns.push({ key: admittedTaskIds.join(',') });
        }
        pushToQuery(prompt, extractAttachments(keep));
        archivePrompts.push({ prompt });
        admittedInbound = true;
        markCompleted(keptIds);
      } catch (err) {
        pollFailed = true;
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
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
        // Second launch site for durable continuations, reached from every
        // early return above (the tick found nothing admissible). It gates on
        // observed provider idleness rather than the prompt ledger, which a
        // merged mid-turn push permanently corrupts — see `turnIdle`.
        if (!admittedInbound && !pollFailed && turnIdle && !done && !endedForCommand) {
          maybeLaunchContinuation(true);
        }
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  /**
   * A bounded busy scope held across `result` HANDLING, not just the turn.
   *
   * Lowering the turn level at `result` is correct — the turn really is over —
   * but the handling that follows completes the initial batch's processing
   * claim and only THEN decides whether to push a corrective follow-up (a
   * task-block nudge, a wrapping retry, a queued continuation). Between the
   * `markCompleted` and that push, a task container has no due row, no claim,
   * no continuation and no raised turn: every reaper term reads idle and a
   * sweep tick landing there kills the container and loses the follow-up this
   * change exists to protect. The scope spans that gap, and because the
   * published bit is the union, closing it leaves the flag raised whenever
   * handling did push a new turn.
   *
   * Idempotent, and also closed in the outer `finally`, so an exception thrown
   * mid-handling cannot leak a scope and pin the container until the ceiling.
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
   * Lower the turn level unless the provider is holding work it has accepted
   * but not started.
   *
   * `claude.ts` merges a mid-turn push into the running turn, so its `result`
   * really does settle everything pushed so far. `opencode.ts` has no merge
   * path: every push is queued as a separate future turn, so the same `result`
   * can arrive with a follow-up already accepted and not yet dispatched.
   * Lowering there publishes idle across the gap between this result and the
   * queued turn's first event — the follow-up rows were completed when they
   * were pushed, so no due row, claim or continuation covers it either — and a
   * sweep tick landing in that gap kills the container and loses the follow-up.
   *
   * The queued turn's own `result` re-runs this check with the queue drained,
   * so the flag still drops on the tick the container really goes idle.
   *
   * Deliberately asks the PROVIDER, not `archivePrompts`: a merged push leaves
   * a phantom ledger entry behind forever (see `turnIdle`), so gating on the
   * ledger would pin every Claude session busy after its first merge.
   */
  const lowerTurnLevelUnlessQueued = (): void => {
    if (query.hasQueuedWork?.()) return;
    setProviderTurnExecuting(false);
  };

  // The initial prompt is a turn the same way a push is; `result` clears it.
  setProviderTurnExecuting(true);
  try {
    for await (const event of query.events) {
      if (event.type === 'error') {
        const err = new ProviderEventError(event);
        if (event.retryable) {
          // SDK's own mid-stream retry signal (api_retry). Don't abort — the
          // SDK retries internally and a result usually follows. Surfaced
          // after the loop only if no result ever arrives.
          log(`Retryable upstream event (${event.message}) — continuing; SDK is retrying`);
          lastRetryableErr = err;
          continue;
        }
        // Report the failure upward instead of writing it. This branch throws,
        // so the OUTER loop decides what happens next: it may recover in-turn
        // (credential rotation, stale-session retry, Codex idle) and call
        // `processQuery` again. Writing here would give one logical fire several
        // failure rows and could alert on a task that recovered moments later.
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

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        sawResult = true; // the SDK produced output → any prior api_retry recovered
        // The provider is between turns as of right now. Set before the
        // handling below, so any push it makes (nudge, continuation launch)
        // clears the flag again and leaves it truthful on exit.
        turnIdle = true;
        // The host's copy of that same fact. It has to be published HERE and
        // not around the whole call: a multi-turn stream stays open after
        // `result` to accept pushes (claude.ts's generator exits only on
        // end()/abort), so a flag cleared on return would sit at 1 through
        // the entire idle stretch and keep the task reaper off a container
        // that has nothing left to do. It lowers only the TURN level: a
        // pre-task script the poll callback started concurrently keeps its own
        // scope, so this cannot cut the ground out from under it. The scope
        // opened first keeps the published bit raised across the handling
        // below, which completes this batch's claim before it decides whether
        // to push a follow-up turn.
        // A provider that QUEUES pushes instead of merging them holds the
        // level up for itself — see lowerTurnLevelUnlessQueued.
        openResultScope();
        lowerTurnLevelUnlessQueued();
        // Fleet Hardening Phase 0.1: one turn_usage row per completed turn,
        // written here because every provider's query converges on this
        // event regardless of which one ran. Whatever the provider didn't
        // expose comes through as NULL — see TurnUsageInfo. A turn spanning
        // multiple models (event.usage as an array) writes one row per model
        // so each is attributed separately instead of collapsing to NULL.
        // steps/duration/trigger/turnId (Phase 0.1 follow-up) are turn-level,
        // not per-model, so every row from a multi-model turn carries the
        // same values — computed once, right here, before anything below can
        // push a follow-up and reset turnStartedAtMs for the NEXT turn.
        // turnId in particular MUST be generated here (once per `result`
        // event), not inside the per-model loop below — it's the field that
        // lets a multi-model turn's split rows be recognized as one turn
        // (usage_daily's row-count-based `turns` over-counts them).
        const turnMeta = {
          turnId: randomUUID(),
          steps: event.steps ?? null,
          durationMs: Date.now() - turnStartedAtMs,
          trigger,
          rateLimitType: event.rateLimit?.type ?? null,
          rateLimitUtilization: event.rateLimit?.utilization ?? null,
          rateLimitResetsAt: event.rateLimit?.resetsAt ?? null,
        };
        // The continuation is the accounting scope for providers that report
        // a running total (Claude's SDK session, Codex's thread) — see
        // turn-usage.ts's toTurnDelta. Without it, the first turn of a new
        // series can be silently subtracted against the previous one's
        // stored total. Empty string when the provider hasn't produced a
        // continuation yet, which just means "one implicit series".
        const usageScope = queryContinuation ?? initialContinuation ?? '';
        for (const usage of Array.isArray(event.usage) ? event.usage : [event.usage]) {
          recordTurnUsage(providerName, usage, turnMeta, usageScope);
        }
        // A `result` event signals the assistant's turn is complete, but the
        // provider's events generator stays open for follow-up `push()` calls
        // (see container/agent-runner/src/providers/claude.ts:1080 — the
        // generator only exits on `stream.end()`/abort). We must NOT flip
        // the `done` flag here; the polling interval depends on `done` to
        // gate follow-up admission, and stopping it after the first result
        // would
        // starve every subsequent inbound trigger=1 row in this session
        // (codex F4, 2026-05-05). The race the prior synchronous flip
        // claimed to fix was illusory: pushes into an open multi-turn stream
        // become the next turn, they're not eaten by the SDK.
        //
        // Mark the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for follow-up
        // pushes. The agent may have responded via MCP (send_message)
        // mid-turn, or the message may not need a response at all — either
        // way the per-turn work for these rows is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          // AUP refusal fast-fail: when Anthropic's content policy filter
          // fires mid-task, the SDK returns a terminal chat response with
          // the literal "API Error: Claude Code is unable to respond...
          // violates our Usage Policy" text. The agent has no further turn
          // and falls silent. If this is a spawned child, sit-and-wait
          // until the parent's no-progress watchdog reaps the task — which
          // it does after 30 minutes, burning real wallclock for no reason
          // and surfacing the failure as the opaque `no_progress_timeout`
          // rather than the actual cause. Emit spawn_failed here so the
          // parent knows immediately and the dashboard card reflects the
          // real reason. Match conservatively: require both anchor phrases
          // (Claude Code prefix + Usage Policy URL) so legitimate prose
          // discussing policy doesn't trip the detector.
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
          const { sent, hasUnwrapped, taskBlocks } = await dispatchResultText(event.text, routing);
          const willRetryTaskBlocks = shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged);
          if (routing.taskRun && !taskBlockNudged)
            recordTaskTurn({ text: event.text, isError: event.isError === true, model: modelInForce });
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
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0]?.prompt ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped || willRetryTaskBlocks ? 'undelivered' : 'completed',
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
            if (!willRetryWrapping && !willRetryTaskBlocks) {
              completeDeliveredPrompt();
            }
          }
        } else {
          // `ProviderEvent.text` is `string | null`, so a terminal result can
          // carry no text at all. That is still a fire that happened, and
          // recording it is what lets a recovered run RESET a stale failure
          // streak — skipping it would leave the streak frozen at its last
          // failing value across a recovery.
          if (routing.taskRun && !taskBlockNudged) {
            recordTaskTurn({ text: '', isError: event.isError === true, model: modelInForce });
          }
          pauseAnsweredPrompt();
        }
        // Handling is done deciding. If it pushed, the turn level is raised
        // again and the published bit stays 1; if it did not, this is where
        // the container becomes reapable.
        closeResultScope();
      } else if (event.type === 'compacted') {
        advanceMemoryContextEpoch(providerName);
        // The SDK auto-compacted the conversation. After compaction the
        // model can lose both the once-per-context bootstrap and learned
        // `<message to="…">` wrapping discipline. Re-inject the bounded
        // canonical index + capabilities immediately, before any queued
        // follow-up can run against the compacted context. This is the
        // runner fallback only: the next host-admitted turn observes the
        // advanced epoch and resumes normal relevant-delta recall.
        const destinations = getAllDestinations();
        let reminder = '[system] Context was just compacted. Canonical memory and capabilities were refreshed.';
        if (destinations.length > 1) {
          const names = destinations.map((d) => d.name).join(', ');
          reminder +=
            ` Reminder: you have ${destinations.length} destinations (${names}). ` +
            'Use <message to="name"> blocks to address them. Bare text goes to the scratchpad fallback only.';
        }
        pushToQuery(ensureFreshContextBootstrap(reminder));
      } else if (event.type === 'file') {
        await dispatchFileAttachment(event, routing);
      }
    }
    // Stream ended with only retryable (api_retry) events and no result → the
    // SDK's internal retries were exhausted. Surface it via the catch below so
    // the user sees a real failure instead of silence. Any result clears this.
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
      // Surface terminal errors to the user. Retryable errors (transient
      // upstream blips, mid-stream retries) stay quiet — only the final
      // failure mode is worth a Slack/Discord post. Without this write the
      // provider yields its error event, the for-await exits, the outer
      // poll-loop iterates into the next turn, and the user sees nothing
      // for up to the host-sweep ABSOLUTE_CEILING_MS (30 min). The thrown-
      // error branch in runPollLoop has its own chat write (search for
      // `Error: ${errMsg}` in this file) — this case is its yielded-event
      // sibling.
      // Quota exhaustion with a declared fallback is reported to the host
      // instead of shown: the session respawns on the fallback provider.
      // See the thrown-error sibling branch for the same decision.
      if (event.retryable === false && event.classification === 'quota') {
        if (await reportProviderUnavailable(null, event.message, true)) break;
      }
      if (event.retryable === false) {
        // `log()` above already covers unconditional logging for this
        // branch — dedupe below only gates the repeated channel post.
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
      // Skip internal MCP tool descriptions ("Using <mcp-tool-name>") — these
      // are implementation details not useful to end users. Only surface
      // substantive progress messages (Bash output, search results, etc.).
      if (event.message.startsWith('Using ')) break;
      // Quiet-status mode (set by tasks with quietStatus: true): suppress
      // all streaming status writes. The agent's final chat message — if
      // any — still goes out via dispatchResultText.
      if (routing.quietStatus) break;
      // Emit a kind='status' message so the host can deliver it as a
      // post-then-edit progress line. Host tracks the platform_message_id
      // per session so subsequent progress events edit in place, and the
      // tracking clears when a real chat message lands.
      // Stamp the turn's batch anchor so the host can tell this status apart
      // from a prior turn's. When a turn ends without a chat-final (no
      // <message> block emitted), the host's chat-final orphan cleanup never
      // runs; the next turn's status carries a different anchor, which the
      // host uses to delete the stale 💭 and post fresh rather than editing
      // the prior turn's message in place. Mirrors the anchor stamped on chat
      // rows (dispatchResultText / dispatchFileAttachment).
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
        content: JSON.stringify({ text: event.message }),
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
    // in_reply_to anchors to the CLAIMED BATCH: this destination's message
    // from the batch if present, else the batch's triggering message. Never
    // a freshly-resolved "latest inbound row" — that row can be a sibling
    // scheduled task's future fire, and stamping it as replied-to permanently
    // suppresses that series (see getPendingMessages' due-aware guard).
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
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 *
 * Tolerant of unclosed openers: when the agent emits a `<message to=…>`
 * without a matching `</message>` (a common degradation mode after long
 * turns, auto-compaction, or extended thinking), the body extends to
 * either the next opener or end-of-text. Without this tolerance, the old
 * regex required a closing tag — a missing close produced zero matches,
 * the entire text fell through to the unwrapped-output fallback, and the
 * literal `<message to=…>` markup leaked to Slack/Discord verbatim.
 *
 * Tag-stripping safety net: if the scratchpad ends up carrying any
 * residual `<message…>` opener/closer text (e.g. the agent emitted
 * `<message to="">` with an empty name that doesn't capture, or other
 * malformed XML), we strip those tokens before posting to the fallback
 * destination so users never see raw wrapper markup.
 */
const MESSAGE_OPENER_RE = /<message\s+to="([^"]*)"\s*>/g;
const MESSAGE_CLOSER = '</message>';
// Tokens we strip from scratchpad / fallback text so the user never sees
// raw wrapper markup even if the parser couldn't pair an opener with a
// closer (e.g. opener with empty `to=""` that we ignored). Anything that
// pairs cleanly is already consumed before this strip runs.
const STRAY_WRAPPER_RE = /<\/?message(?:\s+to="[^"]*")?\s*>/g;

export interface TaskMessageBlock {
  to: string;
  body: string;
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
 * Emitted UNCONDITIONALLY. An earlier version fired only when the turn wrote no
 * chat row, which was wrong three ways: an agent-to-agent reply counts as a chat
 * row but returns from delivery before the orphan cleanup; the flag latched, so
 * status rows produced AFTER an early `send_message` were never cleaned; and a
 * failed insert still marked the turn as having replied. The host is the only
 * component that knows whether a status is actually tracked, and its handler is
 * a no-op when none is — so let it decide rather than guessing here.
 *
 * Called from every turn exit, including the durable work-continuation branch,
 * which returns through its own path. Emitted BEFORE `checkpointTurnEnd` and
 * `markCompleted`: the checkpoint shells out to git and can take seconds, and
 * there is no reason to leave a stale 💭 on screen for it. Callers must not
 * assume inbound rows are already marked completed when this row lands.
 */
async function emitTurnEnd(): Promise<void> {
  await writeMessageOut({ id: generateId(), kind: 'system', content: JSON.stringify({ action: 'turn_end' }) });
}

export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
): Promise<{ sent: number; hasUnwrapped: boolean; taskBlocks: TaskMessageBlock[] }> {
  type Opener = { index: number; endIndex: number; toName: string };
  const openers: Opener[] = [];
  MESSAGE_OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_OPENER_RE.exec(text)) !== null) {
    openers.push({ index: m.index, endIndex: MESSAGE_OPENER_RE.lastIndex, toName: m[1] });
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

    const toName = opener.toName;
    if (!toName) {
      // Opener with empty to="" — treat as malformed; body becomes scratchpad.
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
      // "here" alias: current-conversation shorthand for the origin
      // destination. A real destination literally named "here" wins over
      // the alias — findByName above already checked, so we only get here
      // when no such destination exists. Checked before peer recovery
      // since 'here' is never a peer name.
      if (toName.trim().toLowerCase() === 'here') {
        const origin = findByRouting(routing.channelType, routing.platformId);
        if (origin) {
          log(`to="here" resolved to origin "${origin.name}"`);
          await sendToDestination(origin, body, routing);
          sent++;
          continue;
        }
        // Origin unresolvable — fall through to the unknown-destination
        // handling below instead of inventing new behavior.
      }
      // Recovery: the agent addressed a PEER (sibling) as a destination — a
      // common mistake, esp. opencode (observed: `<message to="Example Agent-Codex">`
      // dropped). Peers aren't destinations; you reach them by @-mentioning in
      // the body of a channel message. Convert it: route the body to the
      // conversation's ORIGIN channel with `@<peer>` ensured in the body, so the
      // handoff actually posts AND wakes the peer instead of vanishing.
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

  // Strip any stray opener/closer tokens that escaped the structured
  // pairing above — these would otherwise reach Slack/Discord verbatim
  // via the unwrapped-output fallback below.
  const scratchpad = stripInternalTags(scratchpadParts.join('').replace(STRAY_WRAPPER_RE, '')).trim();

  // Unwrapped-output fallback: if the agent forgot to wrap (a common
  // failure mode after long turns, auto-compaction, or extended thinking),
  // route the cleaned scratchpad to the most-likely-correct destination
  // instead of silently dropping the reply. Two-tier resolution:
  //
  //   1. Origin (preferred): the destination corresponding to the channel
  //      that triggered this turn. Looked up by (channelType, platformId)
  //      from the routing context. Unambiguous regardless of how many
  //      destinations the agent has wired — the user spoke from one place
  //      and expects the reply there. Works for chat, task, and a2a
  //      inbounds (extractRouting falls back to sessionRouting when the
  //      message itself has no platform_id, so routing fields are
  //      populated for every well-formed turn).
  //
  //   2. Single-destination (legacy): if origin can't be resolved
  //      (routing.platformId is null AND there's no sessionRouting fallback)
  //      AND the group has exactly one destination, send there.
  //
  // The original multi-destination concerns (routing drift on null-routed
  // cron tasks, cross-channel thread bleed in agent-shared sessions;
  // commit 9db39b2) don't apply: sendToDestination resolves fresh
  // per-destination routing via resolveDestinationThread, and we route to
  // the origin (not blindly broadcast) so we never bleed into another
  // channel.
  // Self-wake turns are excluded: their unwrapped output is almost always
  // self-narration of the "nothing changed, no post" decision, and the
  // fallback turned that into channel spam (one no-op status line per wake).
  // A wake that HAS news posts it via an explicit <message> block — the wake
  // prompt states this contract.
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
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** What one terminal task fire should record, if anything. */
export interface FireOutcome {
  text: string;
  isError: boolean;
  model?: string;
}

/**
 * Decide the single outcome a logical fire records — the contract the poll
 * loop's `finally` implements, extracted so it is checkable without driving a
 * provider.
 *
 * Two ways to record nothing, and they are different:
 *
 *   - not a task run: there is no series to attribute an outcome to;
 *   - DEFERRED: the batch was handed to a provider fallback or interrupted by a
 *     repository barrier, both of which leave or release the claim so the SAME
 *     occurrence runs again. That re-run records its own outcome, so recording
 *     here too would give one fire two rows — enough for two occurrences to
 *     trip a threshold set at three, paging a human about a task that was only
 *     postponed (Codex round 3).
 *
 * A reported outcome always wins over a synthesised one: it came from a real
 * terminal result, whereas the synthesised failure exists only for the case
 * where every attempt threw.
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
 * `auto`, `isError` and `model` ride along for the host's durable run-outcome
 * record (`src/db/task-run-outcomes.ts`, migration 075):
 *
 *   - `auto: true` distinguishes this end-of-run summary from a mid-run
 *     `ncl tasks append-log` note. Only the summary is one-per-fire, so only
 *     the summary may count toward a failure streak.
 *   - `isError` is the PROVIDER's own verdict on the turn, which until now the
 *     task path threw away: the result handler acts on `event.isError` only
 *     when `!routing.taskRun`, so a task whose turn errored was recorded
 *     exactly like one that succeeded. That is why a series pinned to a model
 *     its group's provider could not run failed 21 times in 14 hours with
 *     every occurrence row reading `completed` and nobody being told
 *     (2026-09-07, migration 075).
 *   - `model` is what actually ran, so the host can say "pinned to X, group is
 *     on Y" without re-deriving a pin that may since have been edited.
 *
 * An errored turn writes the row even when the text is empty. A failure that
 * leaves no line is precisely the silence this record exists to end.
 */
export async function autoAppendTaskLog(text: string, isError = false, model?: string): Promise<void> {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  // No early return on empty text. Every call here is a TERMINAL task fire, and
  // the host's run-outcome ledger has to see all of them: a failure that
  // returned nothing is the silence this record exists to end, and a blank
  // SUCCESS is what resets a stale failure streak after a recovery.
  await writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({
      text: line || (isError ? '(the provider reported an error and returned no text)' : '(run produced no output)'),
      auto: true,
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
  // Dashboard messages can have no routing stamp in a freshly bound session.
  // Only that origin may inherit the resolved session route. A routed inbound,
  // including an explicit channel-root null, remains authoritative.
  const threadId = destRouting
    ? destRouting.threadId
    : channelType === routing.channelType && platformId === routing.platformId
      ? routing.threadId
      : null;
  await writeMessageOut({
    id: generateId(),
    // Batch anchor, not the channel's latest inbound row — see the poison
    // note in dispatchFileAttachment / getPendingMessages.
    in_reply_to: getBatchAnchor(channelType, platformId) ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id from the most recent inbound message matching the given
 * channel+platform. Returns null if no match found.
 *
 * Thread context ONLY. This used to also return the row's id for use as
 * in_reply_to, which poisoned scheduled-task series: right after a task
 * fires, the newest inbound row for a quiet channel is often a sibling
 * task's freshly-inserted future fire row, and stamping it as "replied to"
 * made getPendingMessages' idempotency guard suppress that fire forever
 * (killed every interleaved daily task between 2026-05-27 and 05-31).
 * in_reply_to must always come from the turn's triggering batch.
 */
function resolveDestinationThread(channelType: string, platformId: string): { threadId: string | null } | null {
  try {
    // getLatestInboundRoute is the same newest-row-per-channel query this ran
    // by hand. Its `inReplyTo` (the row id) is deliberately DROPPED here — see
    // the poison note above; thread context is all this function may return.
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

// Precedence: turn override → sticky. Effort defaults (operator override env +
// per-model-family) are applied inside the claude provider, not here.
// ultracode follows the same precedence; effort is already forced to xhigh
// host-side when ultracode is requested, so it rides alongside effort here.
// Physical chat budget: a task created with muteChat (or chatLimit N) caps
// chat-kind outbound writes for the turn — set BEFORE the provider runs,
// reset at every TURN BOUNDARY (sticky module state would otherwise leak
// across turns). Deliberately NOT part of applyFlagBatch: that also runs
// mid-turn on follow-up batches (see the settings-change path), and a
// mid-turn batch with no task row must not clear an active mute — observed
// live 2026-08-02: a deferred recall row arriving two minutes into a muted
// task turn reset the budget and the "muted" agent posted to the channel.
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
): { model?: string; effort?: string; ultracode?: boolean; fast: boolean } {
  let intent: FlagIntent | undefined;
  for (const m of messages) {
    // Tasks carry flagIntent the same way chat messages do — used by scheduled
    // wake tasks (for example, scheduled reports) to pin model+effort per fire without a
    // global agent-group config change.
    if (m.kind !== 'chat' && m.kind !== 'chat-sdk' && m.kind !== 'task') continue;
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

  const model = intent?.turnModel ?? getStickyModel();
  // Effort here is USER INTENT ONLY (turn flag → sticky flag). Defaults are
  // provider business: the claude provider resolves the operator override
  // (NANOCLAW_EFFORT_OVERRIDE) and per-model-family defaults itself, because
  // only it knows the final model (and e.g. haiku ignores effort). Codex and
  // opencode have their own default surfaces (codex config schema default,
  // opencode model-native) and never consumed this env fold.
  const effort = intent?.turnEffort ?? getStickyEffort();
  const ultracode = intent?.turnUltracode ?? getStickyUltracode() ?? false;
  // Preserve a Codex sticky across provider migrations, but never let it
  // perturb a Claude/OpenCode query or trigger a false mid-turn restart there.
  const fast = providerName === 'codex' ? (intent?.turnFast ?? getStickyFast() ?? false) : false;

  return { model, effort, ultracode, fast };
}

/**
 * The per-turn model/effort a batch should actually run on.
 *
 * A scheduled task has NO default of its own — but it must not inherit an
 * INTERACTIVE one either, and those are two different statements.
 *
 * `applyFlagBatch` resolves `turnModel ?? getStickyModel()`, and the sticky
 * lives in `session_state`: the session's own durable DB, so it survives turns
 * and container restarts for the life of the session. Chat and task messages
 * share a session (which is exactly why `isPureTaskWake` has to ask whether a
 * batch is task-only), so without this an unpinned nightly task fires on
 * whatever `-m` a human last typed in that thread. That is the bug the
 * 2026-07-02 `sonnet`/`xhigh` block was written to fix; the block was right
 * about the disease and wrong about the cure, substituting a hardcoded default
 * the group's own config could neither see nor override. In July it had no
 * alternative — container.json's model did not reach the container.
 *
 * So: SUPPRESS the sticky rather than replace it. `undefined` is not "no
 * model", it is "no per-TURN override", which lets the group's configured
 * model apply exactly as it does for interactive chat — the host exports it as
 * ANTHROPIC_DEFAULT_OPUS_MODEL at spawn (`claudeSpawnEnv`) and the provider
 * reads it at
 * `input.model ?? stickyConfig.model ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL`.
 *
 * Deliberately NOT gated on `providerName === 'claude'`: the sticky is
 * provider-neutral, so a codex or opencode task inherits an interactive `-m`
 * the same way. Only the SUPPRESSION is shared — each provider still resolves
 * its own default from its own config, and codex's `stickyFast` passes through
 * untouched.
 *
 * Called ONLY where a batch OPENS a query. The live-query follow-up path
 * deliberately uses `applyFlagBatch` instead: there, the batch is a fragment
 * of a turn that may belong to a human, and suppressing on it retargeted
 * someone's in-progress answer. See the comment at that call site.
 *
 * `applyFlagBatch` also PERSISTS flag stickies, so this wraps it rather than
 * skipping it — the side effect must still happen for a task batch that
 * carries an explicit flag row.
 */
function effectiveTurnSettings(
  messages: MessageInRow[],
  routing: RoutingContext,
  providerName: string,
): { model?: string; effort?: string; ultracode?: boolean; fast: boolean } {
  const flagBatch = applyFlagBatch(messages, routing, providerName);
  const task = taskWakeIntent(messages);
  if (!task.isPureTaskWake) return flagBatch;
  return {
    model: task.turnModel,
    effort: task.turnEffort,
    // A task pin cannot express ultracode — `validateTaskPin` refuses it,
    // because only the effort half would survive storage — so on a pure task
    // wake a sticky ultracode is inheritance with nothing on the task's side
    // that could have asked for it.
    ultracode: false,
    fast: flagBatch.fast,
  };
}

// A scheduled-task wake is a batch driven purely by kind='task' rows with no
// interactive chat riding along. Returns the task's own per-fire model/effort
// (its stored flagIntent) so the caller can suppress the interactive sticky
// only when the task itself didn't pin one — and skip suppression entirely for
// a mixed chat+task turn (don't downgrade a chat turn a task coincided with).
//
// This asks a DIFFERENT question from the task-turn outcome keying in
// `processQuery`, which reads admitted task-row ids to decide how many outcome
// records a turn produces. That is per admitted TURN and counts fires; this is
// per BATCH and picks a model. Both phrase themselves as "the task rows in
// this batch" and they must not be collapsed: a batch can carry more than one
// admitted turn, so one batch-level model decision can span several outcome
// slots, and that is correct — the model is fixed when the query opens, while
// each joining occurrence still gets its own slot.
function taskWakeIntent(messages: MessageInRow[]): {
  isPureTaskWake: boolean;
  turnModel?: string;
  turnEffort?: string;
} {
  let hasTask = false;
  let hasChat = false;
  // The FIRST task carrying a pin wins, and its axes are taken TOGETHER —
  // matching `applyFlagBatch`, which takes the first intent and `break`s.
  //
  // Reading the last value of each axis independently (as this did) is wrong
  // twice over when a batch carries two differently-pinned tasks: the batch
  // runs under the later task's pin rather than the one that opened it, and
  // model and effort can come from DIFFERENT tasks — synthesising a pair no
  // one configured and which neither task would have validated. Two rules for
  // "which intent governs this batch" is one rule too many.
  let pin: FlagIntent | undefined;
  for (const m of messages) {
    if (m.kind === 'task') {
      hasTask = true;
      if (!pin) {
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
