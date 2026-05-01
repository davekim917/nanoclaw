import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
  getStickyModel,
  setStickyModel,
  clearStickyModel,
  getStickyEffort,
  setStickyEffort,
  clearStickyEffort,
} from './db/session-state.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import { autoCommitDirtyWorktrees } from './worktree-autosave.js';
import { buildSessionRecap, wrapRecap } from './session-recap.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question).
    // Exception: recall_context system messages must reach the prompt path so the agent sees recalled facts.
    const messages = getPendingMessages().filter((m) => {
      if (m.kind !== 'system') return true;
      try {
        const parsed = JSON.parse(m.content) as { subtype?: string };
        return parsed.subtype === 'recall_context';
      } catch {
        return false;
      }
    });
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
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
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
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
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    const { model: effectiveModel, effort: effectiveEffort } = applyFlagBatch(keep, routing);

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(
      `Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}` +
        (effectiveModel ? ` model=${effectiveModel}` : '') +
        (effectiveEffort ? ` effort=${effectiveEffort}` : ''),
    );

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      model: effectiveModel,
      effort: effectiveEffort,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      let recovered = false;

      // Retryable-upstream recovery: 429 / rate limit / overloaded /
      // upstream_error / subscription quota exhausted. If the provider has
      // fallback credentials configured (ANTHROPIC_API_KEY_N or
      // CLAUDE_CODE_OAUTH_TOKEN_N), rotate and retry once in-turn. Without
      // fallbacks OR once they're exhausted, fall through to the error
      // write. Ordered before isContextTooLong because prompt-too-long can
      // LOOK retryable in some error shapes, and the rotation cost is low.
      const rotation = config.provider.isRetryable?.(err)
        ? config.provider.rotateApiKey?.()
        : undefined;
      if (rotation?.rotated) {
        // Continuation is preserved across rotations: the SDK's `resume:`
        // reads a local .jsonl, and the Anthropic API has no account-bound
        // session object — the new credential just signs the next request.
        log(`Upstream transient error — rotated credential, retrying same prompt in-turn`);
        try {
          const retryQuery = config.provider.query({
            prompt,
            continuation,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation && retryResult.continuation !== continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after credential rotation also failed: ${retryMsg}`);
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
      if (!recovered && continuation && config.provider.isContextTooLong?.(err)) {
        log(`Context-too-long detected — clearing session and retrying once with fresh continuation`);
        continuation = undefined;
        clearContinuation(config.providerName);
        try {
          const recap = buildSessionRecap();
          const retryPrompt =
            (recap
              ? wrapRecap(recap, 'context-window-exceeded')
              : '[The prior session exceeded the model context window and was reset. Continuing fresh from here.]\n\n') +
            prompt;
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after context-too-long also failed: ${retryMsg}`);
        }
      } else if (!recovered && continuation && config.provider.isSessionInvalid(err)) {
        // Stale/corrupt continuation — most often a transcript .jsonl
        // that got pruned out from under us, or a session id that was
        // valid in a prior container but doesn't exist in this one's
        // ~/.claude/projects/. Clear and retry once with a recap from
        // the per-session DB so the user doesn't have to re-send and
        // doesn't lose conversational context.
        log(`Stale session detected (${continuation}) — clearing and retrying with recap`);
        continuation = undefined;
        clearContinuation(config.providerName);
        try {
          const recap = buildSessionRecap();
          const retryPrompt =
            (recap
              ? wrapRecap(recap, 'stale-session-recovered')
              : '[The prior agent session transcript was unavailable and could not be resumed. Starting a fresh session.]\n\n') +
            prompt;
          const retryQuery = config.provider.query({
            prompt: retryPrompt,
            continuation: undefined,
            cwd: config.cwd,
            systemContext: config.systemContext,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          const retryResult = await processQuery(retryQuery, routing, processingIds, config.providerName);
          if (retryResult.continuation) {
            continuation = retryResult.continuation;
            setContinuation(config.providerName, continuation);
          }
          recovered = true;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Retry after stale-session recovery also failed: ${retryMsg}`);
        }
      }

      // Only surface the error to the user if we couldn't recover inline.
      if (!recovered) {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `Error: ${errMsg}` }),
        });
      }
    }

    // Per-turn safety net: checkpoint any uncommitted worktree edits so the
    // agent's work survives compaction or a later container kill even if
    // the agent forgot to commit. Mirrors v1's turn-end auto-commit pattern
    // (src/container-runner.ts cleanupThreadWorkspace, pre-fork). Never
    // throws; logs inside autoCommitDirtyWorktrees.
    const autosave = await autoCommitDirtyWorktrees('turn end');
    if (autosave.committed.length > 0 || autosave.failed.length > 0) {
      log(
        `autosave: committed=[${autosave.committed.join(',')}] failed=[${autosave.failed.join(',')}] skipped=${autosave.skipped.length}`,
      );
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

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

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open is
  // strictly cheaper than close+reopen (no cold prompt cache, no reconnect).
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight) return;
    pollInFlight = true;

    void (async () => {
      try {
        // Filtering on thread_id here caused deadlocks when the initial batch
        // and follow-ups had mismatched thread_ids (e.g. a host-generated welcome
        // trigger with null thread vs a Discord DM reply); per-thread sessions
        // already isolate threads, so the router's routing is sufficient.
        //
        // The trigger gate mirrors the cold-start gate at the top of runPollLoop:
        // trigger=0 rows ride the next wake's batch (where the formatter renders
        // them inside <thread_context>). Letting them through here would feed
        // Claude a non-mention as a follow-up user message mid-turn.
        const allPending = getPendingMessages();
        // The host writes recall_context first, then the paired inbound message,
        // both within a single async writeSessionMessage call but with a microtask
        // boundary in between. A mid-turn poll firing in that window would observe
        // the recall_context alone, push it as a follow-up to the WRONG turn, and
        // leave the inbound message to arrive next poll without its recall context.
        // To preserve ordering, only admit a recall_context if its paired trigger
        // message (id == recall_context.id minus 'recall-' prefix) is in the same
        // batch — otherwise hold it for the next poll where the inbound has landed.
        const triggerIdsInBatch = new Set(
          allPending.filter((m) => m.trigger === 1).map((m) => m.id),
        );
        const newMessages = allPending.filter((m) => {
          if (m.kind === 'system') {
            // Exception: recall_context system messages should ride along as
            // additional context for the in-flight turn — but only when the
            // paired trigger message is in this same poll batch.
            try {
              const parsed = JSON.parse(m.content) as { subtype?: string };
              if (parsed.subtype !== 'recall_context') return false;
            } catch {
              return false;
            }
            const pairedTriggerId = m.id.startsWith('recall-') ? m.id.slice('recall-'.length) : null;
            if (!pairedTriggerId || !triggerIdsInBatch.has(pairedTriggerId)) return false;
            return true;
          }
          if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
          if (m.trigger !== 1) return false;
          return true;
        });
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
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
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
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
      writeMessageOut({
        id: generateId(),
        kind: 'status',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: event.message }),
      });
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  if (sent === 0 && scratchpad) {
    if (routing.channelType && routing.platformId) {
      // Reply to the channel/thread the message came from
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id from the inbound routing context so replies land in the
  // same thread the conversation is in. For non-threaded adapters the router
  // strips thread_id at ingest, so this will already be null.
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}

// Precedence: turn override → sticky → host-injected default (NANOCLAW_DEFAULT_EFFORT).
function applyFlagBatch(
  messages: MessageInRow[],
  _routing: RoutingContext,
): { model?: string; effort?: string } {
  let intent: FlagIntent | undefined;
  for (const m of messages) {
    // Tasks carry flagIntent the same way chat messages do — used by scheduled
    // wake tasks (e.g. wiki synthesis) to pin model+effort per fire without a
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
  }

  const model = intent?.turnModel ?? getStickyModel();
  const effort = intent?.turnEffort ?? getStickyEffort() ?? process.env.NANOCLAW_DEFAULT_EFFORT;

  return { model, effort };
}
