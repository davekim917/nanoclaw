/**
 * Delivery action handler for CLI requests from container agents.
 *
 * When an agent writes a `cli_request` system message to outbound.db,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to inbound.db.
 *
 * Execution is at-most-once per (session, request id). The response write is
 * the fragile half — it can fail for reasons that have nothing to do with the
 * command that already succeeded — and a failed handler is re-dispatched by
 * the delivery loop up to `MAX_DELIVERY_ATTEMPTS` times. Without the ledger
 * that retry re-runs the command, so one `ncl tasks create` mints three
 * scheduled series (issue #273). The retry itself is kept: what it retries is
 * the write.
 */
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import { claimCliRequest, completeCliRequest } from './request-ledger.js';

registerDeliveryAction(
  'cli_request',
  async (content, session) => {
    const requestId = content.requestId as string;
    const command = content.command as string;
    const args = (content.args as Record<string, unknown>) ?? {};

    if (!requestId || !command) {
      log.warn('cli_request missing requestId or command', { sessionId: session.id });
      return;
    }

    const req: RequestFrame = { id: requestId, command, args };
    const ctx = {
      caller: 'agent' as const,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messagingGroupId: session.messaging_group_id ?? '',
    };

    const response = await executeOnce(req, ctx);

    // Write response to inbound.db so the container can read it. Its own
    // short mailbox session, because the delivery loop holds none while a
    // handler runs (plan §4.5b).
    //
    // Existing-only, never provisioning. `prepare()` opens the CONTAINER-owned
    // outbound.db read-write to apply its schema, and this handler runs after
    // `dispatch()` has already executed the command — so a prepare that lost a
    // race for that file would fail a completed mutation, the loop would retry
    // the outbound row, and the command would run twice. The request row was
    // just read out of this session's own mailbox, so it exists; if it has
    // vanished, no container is left to read the response.
    // trigger=0: don't wake the agent — this is an inline response to a tool call.
    //
    // `insertMessageIfNew`, not `insertMessage`: the row id is derived from the
    // request id, so a retry that reaches this line after the response already
    // landed (the write succeeded and the delivery loop failed afterwards) must
    // be a no-op rather than a primary-key error that fails the handler again.
    const written = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.insertMessageIfNew({
        id: `cli-resp-${requestId}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        platformId: null,
        channelType: null,
        threadId: null,
        content: JSON.stringify({
          type: 'cli_response',
          requestId,
          frame: response,
        }),
        processAfter: null,
        recurrence: null,
        trigger: 0,
      }),
    );

    if (written === undefined) {
      log.warn('CLI response dropped — session mailbox is gone', { requestId, sessionId: session.id });
      return;
    }

    log.info(written ? 'CLI response written' : 'CLI response already present — retry wrote nothing', {
      requestId,
      ok: response.ok,
      sessionId: session.id,
    });
  },
  unguarded('transport envelope — every inner command is guarded at dispatch'),
);

/**
 * Dispatch the command at most once across every delivery attempt for this
 * request id.
 *
 * Three outcomes:
 *  - fresh      → dispatch, record the frame, return it.
 *  - done       → a previous attempt already ran it; replay the stored frame.
 *  - executing  → a previous attempt claimed it and never recorded an outcome:
 *                 the host died mid-dispatch, or `dispatch()` itself threw.
 *                 Whether the command applied is unknowable, so answer the
 *                 agent honestly instead of guessing by re-running it.
 *
 * A thrown `dispatch()` deliberately leaves its claim standing. It is tempting
 * to hand the claim back on the grounds that `dispatch()` converts every
 * command-handler failure into an error frame, so a throw must have come from
 * its own pre-handler plumbing — but "the command handler never ran" is not
 * "nothing happened". The hold path posts an approval card (writing the
 * pending_approvals row, then delivering it) and can still reject afterwards,
 * and a released claim would card the same request a second time.
 */
async function executeOnce(
  req: RequestFrame,
  ctx: { caller: 'agent'; sessionId: string; agentGroupId: string; messagingGroupId: string },
): Promise<ResponseFrame> {
  const claim = claimCliRequest(ctx.sessionId, req.id, req.command);

  if (claim.state === 'done') {
    log.info('CLI request replayed from the execution ledger — command not re-run', {
      requestId: req.id,
      command: req.command,
      sessionId: ctx.sessionId,
    });
    return claim.response;
  }

  if (claim.state === 'executing') {
    log.warn('CLI request was already dispatched by an earlier attempt — refusing to re-run', {
      requestId: req.id,
      command: req.command,
      sessionId: ctx.sessionId,
    });
    const ambiguous: ResponseFrame = {
      id: req.id,
      ok: false,
      error: {
        code: 'handler-error',
        message:
          `An earlier attempt at this \`ncl ${req.command}\` was dispatched and left no result to replay. ` +
          `It was NOT run again — check whether it took effect, then reissue the command if it did not.`,
      },
    };
    completeCliRequest(ctx.sessionId, req.id, ambiguous);
    return ambiguous;
  }

  log.info('CLI request from agent', { requestId: req.id, command: req.command, sessionId: ctx.sessionId });

  // A throw propagates with the claim still standing, so the delivery loop's
  // retry takes the `executing` branch above rather than dispatching again.
  const response = await dispatch(req, ctx);
  completeCliRequest(ctx.sessionId, req.id, response);
  return response;
}
