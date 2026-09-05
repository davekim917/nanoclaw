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
import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession, markSessionEngaged } from '../../db/sessions.js';
import { sessionStillActive } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { GuardDenyError, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import { upsertArchiveMessage } from '../../message-archive.js';
import { scrubSecrets } from '../../secret-scrubber.js';
import {
  resolveSession,
  sessionDir,
  SessionWriteRefusedError,
  withExistingMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import { prependThreadContext } from '../../thread-context.js';
import type { PendingApproval, Session, SessionMode } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { SessionDbMissingError } from '../mailbox/index.js';
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
  //
  // `undefined` means the mailbox is GONE, which is not the same answer as
  // "this is not a loopback" and must not be spelled as one. Pre-seam this was
  // a definite read that failed hard when inbound storage was missing; the
  // seam's `?? false` quietly converted unknowable provenance into a licence
  // to route, so a self-directed reply nobody could vouch for was accepted,
  // re-provisioned the session and cost an extra self turn.
  //
  // Restored to failing: the caller is asking whether this message is safe to
  // route to itself, and "I cannot tell" is not a yes. A present-but-unreadable
  // DB already raises from the funnel (`SessionDbUnopenableError`), so this
  // only has to close the missing case. Reached only on a self-send, so the
  // blast radius is one agent group talking to itself.
  const loopback = await withExistingMailboxSession(
    session.agent_group_id,
    session.id,
    (mailbox) => mailbox.getInboundSourceSessionId(msg.in_reply_to as string) === session.id,
  );
  if (loopback === undefined) {
    // The session DIRECTORY, not a reconstructed inbound.db path: naming the
    // file here would mean importing a raw-path helper into a module the
    // mailbox-seam ratchet keeps off raw session-DB access, and the ratchet
    // only ever shrinks. The directory is where the missing database lives and
    // is what an operator needs to look at.
    throw new SessionDbMissingError(sessionDir(session.agent_group_id, session.id));
  }
  return loopback;
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
  // A THUNK, not a value. The wiring gate that decides whether the caller's
  // messaging group may be inherited is a central-DB read, and the lookup
  // below awaits — so a value computed by the caller is a proof from before
  // the yield, used to link a session created after it. Evaluated once, after
  // the await, immediately before the branch that resolves or creates.
  freshFallback: () => Promise<SessionFallback>,
  // Returns the fallback it actually used, so callers that need the caller's
  // effective mg context after this point read the same one that governed the
  // session link rather than their own pre-await copy.
): Promise<{ session: Session; created: boolean; fallback: SessionFallback }> {
  // Both lookups read the SOURCE session's queue, in one short session of its
  // own. Existing-only, and `undefined` means the mailbox is GONE — which is
  // not the same answer as "this reply has no return path".
  //
  // `?? null` spelled it as one, and the difference is a delivery: unprovable
  // provenance fell through to `resolveSession`, which picks the newest active
  // session of the target or creates one. A reply whose origin nobody could
  // vouch for was then delivered to a session that never took part in the
  // conversation. This is the same definite-read semantics restored at the
  // self-loopback site; the two sites read the same storage and must answer
  // "I cannot tell" the same way.
  //
  // A present-but-unreadable DB already raises from the funnel
  // (`SessionDbUnopenableError`), so this only has to close the missing case.
  const lookup = await withExistingMailboxSession(sourceSession.agent_group_id, sourceSession.id, (mailbox) => {
    const direct = msg.in_reply_to ? mailbox.getInboundSourceSessionId(msg.in_reply_to) : null;
    // Peer-affinity fallback — covers the case where the container's
    // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
    // path, container running pre-fix code).
    return direct ?? mailbox.getMostRecentPeerSourceSessionId(targetAgentGroupId);
  });
  if (lookup === undefined) {
    // The session DIRECTORY, not a reconstructed inbound.db path: the ratchet
    // keeps this module off raw session-DB access and only ever shrinks.
    throw new SessionDbMissingError(sessionDir(sourceSession.agent_group_id, sourceSession.id));
  }
  const originSessionId = lookup;
  // Re-derived here, after the yield and before anything is resolved or
  // created. If the wiring was revoked in the window this now takes the same
  // agent-shared path the pre-check takes on failure, so the outcome matches
  // what an identical request arriving a moment later would get.
  const fallback = await freshFallback();
  if (originSessionId) {
    const candidate = await getSession(originSessionId);
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
      //
      // `fallback.mgId === null` has TWO causes and they are not the same
      // permission. Either the caller is genuinely agent-shared — nothing was
      // inherited, and the originating-session semantic above applies — or the
      // caller HAS a messaging group and `resolveFallback` just refused to
      // inherit it because the target's wiring was revoked during the awaited
      // lookup. Reading the second as the first reuses an mg-bound candidate
      // and delivers into a chat the target is no longer wired to, which is the
      // exact bypass the cross-tenant gate exists to prevent.
      //
      // So an mg-BOUND candidate is accepted only while that wiring still
      // exists, asked here rather than inferred from `fallback`. An
      // agent-shared candidate binds no chat and needs no such proof. Self-sends
      // keep their own threading, as the original gate exempts them.
      const candidateMgId = candidate.messaging_group_id;
      const candidateWiringHolds =
        candidateMgId === null || targetAgentGroupId === sourceSession.agent_group_id
          ? true
          : await withCentralSync(
              () => targetWiredToMessagingGroup(targetAgentGroupId, candidateMgId),
              'agent-route candidate wiring',
            );
      if (!candidateWiringHolds) {
        log.info('agent-route: return-path candidate abandoned — target no longer wired to its chat', {
          from: sourceSession.agent_group_id,
          to: targetAgentGroupId,
          candidateSession: candidate.id,
          candidateMgId,
        });
      } else if (fallback.mgId === null || candidate.messaging_group_id === fallback.mgId) {
        return { session: candidate, created: false, fallback };
      }
    }
  }
  return { ...(await resolveSession(targetAgentGroupId, fallback.mgId, fallback.threadId, fallback.mode)), fallback };
}

/**
 * Is this agent group still wired to this messaging group?
 *
 * The same question `resolveFallback` asks before inheriting a caller's chat,
 * named once so the return-path candidate can ask it too and the two cannot
 * drift into different definitions of "wired".
 */
function targetWiredToMessagingGroup(agentGroupId: string, messagingGroupId: string): boolean {
  // Synchronous by design (seam-3 plan §4.5, I-1): this is the agent-route
  // guard, evaluated inside `writeSessionMessage`'s `withCentralSync` block
  // with nothing awaited between it and the insert. Every other caller takes
  // the lease itself (`withCentralSync`) around the block that asks.
  return (
    withRawDb((raw) =>
      raw
        .prepare('SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?')
        .get(agentGroupId, messagingGroupId),
    ) !== undefined
  );
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

  const decision = await withCentralSync(
    () =>
      guard(a2aSend, {
        actor: { kind: 'agent', agentGroupId: sourceAgentGroupId, sessionId: session.id },
        resource: { from: sourceAgentGroupId, to: targetAgentGroupId },
        payload: { id: msg.id, platform_id: targetAgentGroupId, content: msg.content, in_reply_to: msg.in_reply_to },
        grant: opts.grant ?? null,
      }),
    'a2a.send gate',
  );
  if (decision.effect === 'deny') {
    throw new GuardDenyError(decision.reason);
  }

  // Gated edge: hold the message and return (not throw) so the delivery loop
  // consumes the outbound row; `applyA2aMessageGate` re-enters here with the
  // grant on approve.
  if (decision.effect === 'hold') {
    const sourceName = (await getAgentGroup(sourceAgentGroupId))?.name ?? sourceAgentGroupId;
    const targetName = (await getAgentGroup(targetAgentGroupId))?.name ?? targetAgentGroupId;
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

  await performAgentRoute(msg, session, targetAgentGroupId, opts.grant ?? null);
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
  // Carried so the destination grant can be re-proved where the write is,
  // rather than only where the route was decided.
  grant: PendingApproval | null,
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
  // Named and re-runnable because it is re-run: the session below is resolved
  // behind an await, and this gate must hold at the moment the link is made,
  // not merely when the message arrived.
  const resolveFallback = (): SessionFallback => {
    let inheritMg = false;
    if (callerMgId && targetAgentGroupId !== session.agent_group_id) {
      inheritMg = targetWiredToMessagingGroup(targetAgentGroupId, callerMgId);
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
    return {
      mgId: effectiveMgId,
      threadId: inheritMg ? callerThreadId : null,
      mode: effectiveMgId ? 'per-thread' : 'agent-shared',
    };
  };
  // Return-path lookup (in_reply_to → source_session_id) takes precedence
  // when the candidate session matches the caller's effective mg context;
  // otherwise we fall through to the threading-aware resolveSession.
  const { session: targetSession, fallback: effective } = await resolveTargetSession(
    msg,
    session,
    targetAgentGroupId,
    // The wiring read inside is the agent-route guard's raw read, so the
    // re-run takes the lease around it.
    () => withCentralSync(resolveFallback, 'agent-route fallback'),
  );

  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Every channel delivery scrubs registered secret values before the text
  // leaves the host (delivery.ts, `scrubbedContent`). The a2a branch returns
  // before that point, so scrub here too: without it a token the sending
  // agent echoed lands verbatim in the peer's inbound DB — and, below, in the
  // workgroup-wide archive. Secret scoping is per agent group (onecliSecrets),
  // so "both ends are our agents" is not a reason to skip it.
  const scrubbed = scrubSecrets(msg.content);

  // AUTHORIZATION IS RE-PROVED TWICE, because this function has two awaits and
  // two side effects, and each proof sits adjacent to the effect it authorizes.
  //
  // The `a2aSend` guard in `routeAgentMessage` ran before the source-mailbox
  // lookup above; the thread-context build below can be a platform HTTP call
  // lasting seconds. An admin revoking this `agent_destinations` grant inside
  // either window must not get the payload delivered by either route — and file
  // BYTES are a delivery: they land in the target's inbox, which its container
  // mounts and reads, with or without an inbound row pointing at them.
  //
  // Synchronous, with nothing awaited between a proof and the effect after it.
  // `grant` is passed exactly as the first call did, so an approved replay
  // re-proves on the terms it was approved under rather than being denied by
  // its own approval. A `hold` counts as a refusal both times: this invocation
  // already cleared the gate once, and asking again would double-prompt the
  // operator for one message.
  const proveDestination = () =>
    guard(a2aSend, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      resource: { from: session.agent_group_id, to: targetAgentGroupId },
      payload: { id: msg.id, platform_id: targetAgentGroupId, content: msg.content, in_reply_to: msg.in_reply_to },
      grant,
    });
  const refuse = (reason: string | undefined, stage: 'before the file copy' | 'before the write'): never => {
    log.warn('agent-route: destination grant was revoked while routing; dropping the message', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      msgId: msg.id,
      stage,
      reason,
    });
    throw new GuardDenyError(reason ?? 'destination grant revoked while routing');
  };

  // PROOF ONE, before the copy. Nothing has been written yet, so this refusal
  // leaves nothing to undo. Under the lease, because the guard's reads are
  // raw; proof TWO runs inside the writer's own block.
  const beforeCopy = await withCentralSync(proveDestination, 'a2a.send proof before copy');
  if (beforeCopy.effect !== 'allow') refuse(beforeCopy.reason, 'before the file copy');

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const { content: forwardedContent, writtenPaths } = forwardFileAttachments(
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
  // The SAME fallback that governed the session link above, not a copy taken
  // before the await — otherwise a wiring revoked in that window would leave
  // the backfill quoting a chat the target session is no longer bound to.
  const contentForWrite = await addThreadContext(forwardedContent, effective.mgId, effective.threadId, targetSession);

  // PROOF TWO IS NOW THE WRITER'S, not ours.
  //
  // A synchronous check here proves the grant held before `writeSessionMessage`
  // was CALLED. That function then awaits — a storage-activity lease, a
  // reclaim-journal import, the mailbox funnel — before the row lands, and a
  // revocation inside any of those windows still got the message delivered.
  // No amount of care at this call site can close a window inside the callee,
  // so the proof is handed to the callee, which evaluates it with nothing
  // awaited between the answer and the insert.
  //
  // The refusal keeps this function's contract: `SessionWriteRefusedError`
  // becomes the same `GuardDenyError` the pre-checks raise, and the copied
  // bytes are removed on the way out exactly as before.
  try {
    await writeSessionMessage(
      targetAgentGroupId,
      targetSession.id,
      {
        id: a2aMsgId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: contentForWrite,
        sourceSessionId: session.id,
      },
      {
        // TWO preconditions, both re-proved by the writer at the insert.
        //
        // The destination grant, and — for a target session BOUND to a chat —
        // that the target is still wired to it. The session was chosen before
        // `addThreadContext` and before this call's own awaits, so a wiring
        // revoked in either window would otherwise deliver into a chat the
        // target no longer belongs to.
        guard: () => {
          const verdict = proveDestination();
          if (verdict.effect !== 'allow') {
            return { ok: false as const, reason: verdict.reason ?? 'destination grant revoked while routing' };
          }
          const targetMgId = targetSession.messaging_group_id;
          if (
            targetMgId !== null &&
            targetAgentGroupId !== session.agent_group_id &&
            !targetWiredToMessagingGroup(targetAgentGroupId, targetMgId)
          ) {
            return { ok: false as const, reason: `target is no longer wired to messaging group ${targetMgId}` };
          }
          return true;
        },
      },
    );
  } catch (err) {
    if (err instanceof SessionWriteRefusedError) {
      removeForwardedFiles(writtenPaths);
      refuse(err.reason, 'before the write');
    }
    throw err;
  }
  // Archived only once the row is durable, and from `scrubbed` rather than
  // `contentForWrite` — the archive holds the message the peer actually sent,
  // not the thread transcript we wrapped around it.
  await archiveRoutedMessage(scrubbed, a2aMsgId, session.agent_group_id, targetAgentGroupId, targetSession);
  // An a2a message is one of the three engagement events, so the target
  // session is engaged from here — the row is durable and the wake follows.
  await markSessionEngaged(targetSession.id);
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  // The wake's own precondition goes to the wake path for the same reason. The
  // pre-wake `getSession` here proved the target was live before `wakeContainer`
  // was called; that function then awaits admission, an unbounded memory-queue
  // wait and all of `spawnContainer`'s preparation before a process exists.
  // The shared guard, not a hand-rolled copy: this one asked only about
  // `status`, and `archiveSessionById` stamps `archived_at` while leaving
  // `status` alone — so an archived target still read `active` here. One
  // definition of "still live" cannot drift from itself.
  await requestWake(targetSession, 'inbound-message', {
    priority: 'interactive',
    guard: sessionStillActive(targetSession.id),
  });
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
async function archiveRoutedMessage(
  content: string,
  a2aMsgId: string,
  sourceAgentGroupId: string,
  targetAgentGroupId: string,
  targetSession: Session,
): Promise<void> {
  const { text } = parseMessageContent(content);
  if (!text) return;
  const sourceName = (await getAgentGroup(sourceAgentGroupId))?.name ?? sourceAgentGroupId;
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
  const mg = await getMessagingGroup(mgId);
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
/**
 * The forwarded content, plus the absolute paths the copy actually created.
 *
 * The paths are returned rather than reconstructed by the caller: the only
 * place that knows where a byte landed is the code that wrote it, and a caller
 * rebuilding `sessionDir(...) + localPath` would be a second definition of that
 * — one that stops matching the moment the layout changes. They stay OUT of
 * `content`, which is what an absolute host path must never leak into.
 */
interface ForwardedContent {
  content: string;
  /** Absolute, host-side. Empty when nothing was copied. */
  writtenPaths: string[];
}

function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): ForwardedContent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return { content: msg.content, writtenPaths: [] };
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return { content: msg.content, writtenPaths: [] };
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return { content: msg.content, writtenPaths: [] };

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

  const targetSessionRoot = sessionDir(targetAgentGroupId, targetSessionId);
  return {
    content: JSON.stringify(parsed),
    writtenPaths: attachments.map((attachment) => path.join(targetSessionRoot, attachment.localPath)),
  };
}

/**
 * Remove attachments this route copied, when the route then refuses to write.
 *
 * The bytes are the side effect the caller cannot take back any other way: the
 * inbound row is never inserted on a denial, but the files are already in the
 * target's inbox, where its container mounts and reads them. Leaving them is a
 * silent partial delivery of exactly the payload the guard just refused.
 *
 * Best-effort by construction. A file that will not unlink is logged and the
 * denial still stands — failing to clean up must not turn a refusal into a
 * successful route. The now-empty message directory is removed too, and only
 * if it IS empty, so a concurrent writer's file is never taken with it.
 */
function removeForwardedFiles(writtenPaths: string[]): void {
  const dirs = new Set<string>();
  for (const file of writtenPaths) {
    try {
      fs.rmSync(file, { force: true });
      dirs.add(path.dirname(file));
    } catch (err) {
      log.warn('agent-route: could not remove a forwarded file after the route was denied', { file, err });
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Non-empty or already gone. Either is fine — this is tidying, not the
      // guarantee; the guarantee is that the refused bytes are gone.
    }
  }
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
