/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-chat messages are allowed (used for deliberate notes injected back
 * into an agent's own session). Self-directed status messages are dropped:
 * streaming progress is output, never a new input turn.
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { ensureContainedInboxDir, isPathInside } from '../../inbox-safety.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { gateCommand } from '../../command-gate.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession, markSessionEngaged } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { GuardDenyError, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { upsertArchiveMessage } from '../../message-archive.js';
import { scrubSecrets } from '../../secret-scrubber.js';
import { resolveSession, sessionDir, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import { prependThreadContext } from '../../thread-context.js';
import type { PendingApproval, Session, SessionMode } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { A2A_MESSAGE_GATE_ACTION, a2aSend } from './guard.js';

export { isSafeAttachmentName };
export { A2A_MESSAGE_GATE_ACTION } from './guard.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  if (!isSafeAttachmentName(source.messageId)) {
    log.warn('agent-route: rejecting unsafe source outbox message id', { sourceMsgId: source.messageId });
    return [];
  }

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  let realSourceDir: string;
  try {
    const sourceDirStat = fs.lstatSync(sourceDir);
    if (!sourceDirStat.isDirectory() || sourceDirStat.isSymbolicLink()) {
      log.warn('agent-route: rejecting unsafe source outbox dir', {
        sourceMsgId: source.messageId,
        sourceDir,
      });
      return [];
    }
    realSourceDir = fs.realpathSync(sourceDir);
  } catch (err) {
    log.warn('agent-route: failed to inspect source outbox dir', {
      sourceMsgId: source.messageId,
      sourceDir,
      err,
    });
    return [];
  }

  // Target-side containment — shared with the channel-inbound path. A
  // compromised target agent can write inside its own session dir, so it could
  // pre-place `inbox` (or `inbox/<future-msgId>`) as a symlink pointing
  // anywhere host-writable; ensureContainedInboxDir refuses the symlink before
  // any copy lands outside the sandbox (#2828, CWE-59).
  const inboxRoot = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox');
  const targetInboxDir = ensureContainedInboxDir(inboxRoot, target.messageId, {
    targetGroup: target.agentGroupId,
    targetSession: target.sessionId,
    targetMsgId: target.messageId,
  });
  if (!targetInboxDir) {
    return [];
  }

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    let realSrc: string;
    try {
      const srcStat = fs.lstatSync(src);
      if (!srcStat.isFile() || srcStat.isSymbolicLink()) {
        log.warn('agent-route: rejecting unsafe source outbox file', {
          sourceMsgId: source.messageId,
          filename,
        });
        continue;
      }
      realSrc = fs.realpathSync(src);
    } catch {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    if (!isPathInside(realSourceDir, realSrc)) {
      log.warn('agent-route: rejecting source file outside source outbox dir', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    try {
      // COPYFILE_EXCL: fail with EEXIST rather than follow or overwrite a
      // pre-placed symlink / existing file at dst — the host is the sole
      // writer of these attachments.
      fs.copyFileSync(realSrc, dst, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      log.warn('agent-route: refusing to write target inbox file', {
        sourceMsgId: source.messageId,
        targetMsgId: target.messageId,
        filename,
        err,
      });
      continue;
    }
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  kind?: string;
  platform_id: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
}

async function isExactSameSessionLoopback(msg: RoutableAgentMessage, session: Session): Promise<boolean> {
  if (!msg.in_reply_to) return false;
  // A read of the caller's own queue: existing-only, never provisioning.
  // `undefined` (mailbox gone) is not a loopback.
  return (
    (await withExistingMailboxSession(
      session.agent_group_id,
      session.id,
      (mailbox) => mailbox.getInboundSourceSessionId(msg.in_reply_to as string) === session.id,
    )) ?? false
  );
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 */
interface SessionFallback {
  mgId: string | null;
  threadId: string | null;
  mode: Exclude<SessionMode, 'shared'>;
}

async function resolveTargetSession(
  msg: RoutableAgentMessage,
  sourceSession: Session,
  targetAgentGroupId: string,
  fallback: SessionFallback,
): Promise<{ session: Session; created: boolean }> {
  // Both lookups read the SOURCE session's queue, in one short session of its
  // own. Existing-only: this is the return-path read, and a source whose
  // mailbox is gone simply falls through to the newest-active heuristic.
  const originSessionId =
    (await withExistingMailboxSession(sourceSession.agent_group_id, sourceSession.id, (mailbox) => {
      const direct = msg.in_reply_to ? mailbox.getInboundSourceSessionId(msg.in_reply_to) : null;
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      return direct ?? mailbox.getMostRecentPeerSourceSessionId(targetAgentGroupId);
    })) ?? null;
  if (originSessionId) {
    const candidate = getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      // Return-path candidate is authenticated by the source_session_id
      // chain — the host stamps it at write time when an a2a outbound
      // becomes the recipient's inbound, and getInboundSourceSessionId
      // only resolves rows in the *caller's* inbound. So a candidate
      // here means: this caller and that target session previously
      // communicated. The candidate's mg may differ from the caller's
      // effective mg (e.g. test #2332: PA.paSlackSession sends to
      // researcher; researcher's reply must land back in paSlackSession
      // even though researcher itself is in agent-shared mode and
      // fallback.mgId is null). The originating-session semantic wins;
      // any cross-mg context already crossed at the original send.
      if (fallback.mgId === null || candidate.messaging_group_id === fallback.mgId) {
        return { session: candidate, created: false };
      }
    }
  }
  return resolveSession(targetAgentGroupId, fallback.mgId, fallback.threadId, fallback.mode);
}

export async function routeAgentMessage(
  msg: RoutableAgentMessage,
  session: Session,
  opts: { grant?: PendingApproval } = {},
): Promise<void> {
  const sourceAgentGroupId = session.agent_group_id;
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  const isSelf = targetAgentGroupId === sourceAgentGroupId;
  const loopReason =
    isSelf && msg.kind === 'status'
      ? 'self-directed status'
      : isSelf && (await isExactSameSessionLoopback(msg, session))
        ? 'same-session loopback'
        : null;
  if (loopReason) {
    log.warn('agent-route: dropping self-directed loop message', {
      agentGroupId: sourceAgentGroupId,
      sessionId: session.id,
      msgId: msg.id,
      reason: loopReason,
    });
    return;
  }

  // Slash-command parity with the channel path (router.ts → `gateCommand`).
  // `/clear`, `/compact`, `/files` and friends are admin-only for humans; a
  // peer agent is not a user and can never hold admin privilege, so it must
  // not be able to wipe or reconfigure another agent's session by putting one
  // in a message. Dropped rather than denied — there is no human to explain a
  // refusal to, and the sending agent has no ack channel for send_message.
  const commandGate = gateCommand(msg.content, null, targetAgentGroupId);
  if (commandGate.action !== 'pass') {
    log.warn('agent-route: dropping privileged slash command from a peer agent', {
      from: sourceAgentGroupId,
      to: targetAgentGroupId,
      msgId: msg.id,
      action: commandGate.action,
      command: commandGate.action === 'deny' ? commandGate.command : undefined,
    });
    return;
  }

  const decision = guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: sourceAgentGroupId, sessionId: session.id },
    resource: { from: sourceAgentGroupId, to: targetAgentGroupId },
    payload: { id: msg.id, platform_id: targetAgentGroupId, content: msg.content, in_reply_to: msg.in_reply_to },
    grant: opts.grant ?? null,
  });
  if (decision.effect === 'deny') {
    throw new GuardDenyError(decision.reason);
  }

  // Gated edge: hold the message and return (not throw) so the delivery loop
  // consumes the outbound row; `applyA2aMessageGate` re-enters here with the
  // grant on approve.
  if (decision.effect === 'hold') {
    const sourceName = getAgentGroup(sourceAgentGroupId)?.name ?? sourceAgentGroupId;
    const targetName = getAgentGroup(targetAgentGroupId)?.name ?? targetAgentGroupId;
    await requestApproval({
      session,
      agentName: sourceName,
      action: A2A_MESSAGE_GATE_ACTION,
      approverUserId: decision.approverUserId,
      title: 'Message approval',
      question: buildGateQuestion(sourceName, targetName, msg.content),
      payload: {
        id: msg.id,
        platform_id: targetAgentGroupId,
        content: msg.content,
        in_reply_to: msg.in_reply_to,
      },
    });
    log.info('Agent message held for approval', {
      from: sourceAgentGroupId,
      to: targetAgentGroupId,
      msgId: msg.id,
    });
    return;
  }

  await performAgentRoute(msg, session, targetAgentGroupId);
}

const GATE_CARD_BODY_MAX = 1500;

function parseMessageContent(contentStr: string): { text: string; files: string[] } {
  try {
    const parsed = JSON.parse(contentStr) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
  } catch {
    return { text: contentStr, files: [] };
  }
}

function buildGateQuestion(sourceName: string, targetName: string, contentStr: string): string {
  const { text, files } = parseMessageContent(contentStr);
  const body = text.length > GATE_CARD_BODY_MAX ? `${text.slice(0, GATE_CARD_BODY_MAX)}… (truncated)` : text;
  const lines = [`Agent "${sourceName}" wants to send a message to "${targetName}":`, '', body];
  if (files.length > 0) lines.push('', `Attachments: ${files.join(', ')}`);
  lines.push(
    '',
    `Approve, Reject, or "Reject with reason…" to decline and then type a short reason I'll relay to "${sourceName}".`,
  );
  return lines.join('\n');
}

/**
 * Cross-session route: pick the target session, forward files, write to its
 * inbound DB, wake it. Module-private — the only door is routeAgentMessage's
 * guard decision (the approve continuation re-enters with a grant rather
 * than calling this directly).
 */
async function performAgentRoute(
  msg: RoutableAgentMessage,
  session: Session,
  targetAgentGroupId: string,
): Promise<void> {
  // Inherit the calling agent's threading context so cross-agent sessions
  // are scoped per-thread (when the caller is per-thread) instead of
  // collapsed to a single session per target agent. Memory and workspace
  // remain shared at the agent level — only the conversation history is
  // partitioned per-thread, matching how the user-facing channel agents
  // behave by default. When the caller has no mg context (caller is itself
  // in agent-shared mode), fall back to agent-shared on the target so we
  // still find/reuse the existing session instead of leaking a fresh one
  // per call.
  //
  // SECURITY (cross-tenant audit 2026-05-03): only inherit the caller's
  // messaging_group_id when the target agent is ALSO wired to it via
  // messaging_group_agents. Without this gate, an A2A message from tenant A
  // would create a target-side session linked to A's chat, and a default
  // `send_message` from the target (no `to` argument) would post into A's
  // chat — bypassing the wiring ACL. When the target isn't wired, fall back
  // to agent-shared mode so the target session has no inherited chat
  // surface. Self-sends (target == source) are exempt from this check.
  const callerMgId = session.messaging_group_id;
  const callerThreadId = session.thread_id;
  let inheritMg = false;
  if (callerMgId && targetAgentGroupId !== session.agent_group_id) {
    const wired = getDb()
      .prepare('SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?')
      .get(targetAgentGroupId, callerMgId) as { ok: number } | undefined;
    inheritMg = !!wired;
    if (!inheritMg) {
      log.info('agent-route: target not wired to caller mg — using agent-shared session', {
        from: session.agent_group_id,
        to: targetAgentGroupId,
        callerMgId,
      });
    }
  } else if (targetAgentGroupId === session.agent_group_id) {
    // Self-send: keep caller's threading.
    inheritMg = !!callerMgId;
  }
  const effectiveMgId = inheritMg ? callerMgId : null;
  const effectiveThreadId = inheritMg ? callerThreadId : null;
  const targetMode: Exclude<SessionMode, 'shared'> = effectiveMgId ? 'per-thread' : 'agent-shared';
  // Return-path lookup (in_reply_to → source_session_id) takes precedence
  // when the candidate session matches the caller's effective mg context;
  // otherwise we fall through to the threading-aware resolveSession.
  const { session: targetSession } = await resolveTargetSession(msg, session, targetAgentGroupId, {
    mgId: effectiveMgId,
    threadId: effectiveThreadId,
    mode: targetMode,
  });

  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Every channel delivery scrubs registered secret values before the text
  // leaves the host (delivery.ts, `scrubbedContent`). The a2a branch returns
  // before that point, so scrub here too: without it a token the sending
  // agent echoed lands verbatim in the peer's inbound DB — and, below, in the
  // workgroup-wide archive. Secret scoping is per agent group (onecliSecrets),
  // so "both ends are our agents" is not a reason to skip it.
  const scrubbed = scrubSecrets(msg.content);

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(
    { ...msg, content: scrubbed },
    a2aMsgId,
    session,
    targetAgentGroupId,
    targetSession.id,
  );

  // Thread-history backfill, matching what a platform @mention wake gets
  // (router.ts). An a2a hand-off can land in a thread the target has never
  // spoken in, and nothing else would ever give it that context.
  // `targetSession` was read before `markSessionEngaged` runs below, so its
  // `engaged_at` still describes the state BEFORE this wake — the question the
  // backfill asks.
  const contentForWrite = await addThreadContext(forwardedContent, effectiveMgId, effectiveThreadId, targetSession);

  await writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: contentForWrite,
    sourceSessionId: session.id,
  });
  // Archived only once the row is durable, and from `scrubbed` rather than
  // `contentForWrite` — the archive holds the message the peer actually sent,
  // not the thread transcript we wrapped around it.
  archiveRoutedMessage(scrubbed, a2aMsgId, session.agent_group_id, targetAgentGroupId, targetSession);
  // An a2a message is one of the three engagement events, so the target
  // session is engaged from here — the row is durable and the wake follows.
  markSessionEngaged(targetSession.id);
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Mirror the routed message into the central archive, the way router.ts
 * mirrors channel inbound. The archive and the pre-turn recall lane index the
 * archive, not the per-session DBs, so without this an agent-to-agent
 * hand-off is unfindable through the whole retrieval layer.
 *
 * One row, not two: this is a single message, and the archive is scoped by
 * workgroup member set — a same-workgroup sender finds the target's row.
 * Attributed to the receiving agent group with the sender named, mirroring
 * how an inbound user message is archived.
 */
function archiveRoutedMessage(
  content: string,
  a2aMsgId: string,
  sourceAgentGroupId: string,
  targetAgentGroupId: string,
  targetSession: Session,
): void {
  const { text } = parseMessageContent(content);
  if (!text) return;
  const sourceName = getAgentGroup(sourceAgentGroupId)?.name ?? sourceAgentGroupId;
  upsertArchiveMessage({
    id: a2aMsgId,
    agentGroupId: targetAgentGroupId,
    messagingGroupId: targetSession.messaging_group_id,
    channelType: 'agent',
    channelName: sourceName,
    platformId: sourceAgentGroupId,
    threadId: targetSession.thread_id,
    role: 'user',
    senderId: sourceAgentGroupId,
    senderName: sourceName,
    text,
    sentAt: new Date().toISOString(),
  });
}

/**
 * Prepend the platform thread's recent history when the target session is
 * bound to a real chat thread. No-op for agent-shared targets (no chat
 * surface to read) and for adapters without the hook.
 */
async function addThreadContext(
  content: string,
  mgId: string | null,
  threadId: string | null,
  target: Session,
): Promise<string> {
  if (!mgId || !threadId) return content;
  const mg = getMessagingGroup(mgId);
  if (!mg) return content;
  const adapter = getChannelAdapter(mg.instance ?? mg.channel_type);
  if (!adapter?.fetchThreadHistory) return content;

  // Not `withThreadContext`: a2a content is only USUALLY a JSON body, and a
  // peer that sent plain text must still route. The parse stays tolerant here.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
  const original = typeof parsed.text === 'string' ? parsed.text : '';
  const withContext = await prependThreadContext(original, { session: target, adapter, threadId });
  if (withContext === original) return content;
  parsed.text = withContext;
  return JSON.stringify(parsed);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
