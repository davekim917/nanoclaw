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
 * scheduled series. The retry itself is kept: what it retries is
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

    // Existing-only, never provisioning: `prepare()` opens the container-owned outbound.db read-write, and failing
    // here after `dispatch()` ran would make the loop retry and run the command twice. trigger=0: an inline tool
    // response must not wake the agent. `insertMessageIfNew` because the row id derives from the request id, so a
    // retry after the response landed must be a no-op, not a primary-key error.
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
 * Dispatches at most once per request id. `executing` (claimed, never completed) is answered honestly rather than
 * guessed by re-running. A thrown `dispatch()` deliberately keeps its claim: the hold path posts an approval card and
 * can still throw afterwards, so releasing the claim would card the same request twice.
 */
async function executeOnce(
  req: RequestFrame,
  ctx: { caller: 'agent'; sessionId: string; agentGroupId: string; messagingGroupId: string },
): Promise<ResponseFrame> {
  const claim = await claimCliRequest(ctx.sessionId, req.id, req.command);

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
    await completeCliRequest(ctx.sessionId, req.id, ambiguous);
    return ambiguous;
  }

  log.info('CLI request from agent', { requestId: req.id, command: req.command, sessionId: ctx.sessionId });

  // A throw keeps the claim, so the retry takes the `executing` branch.
  const response = await dispatch(req, ctx);
  await completeCliRequest(ctx.sessionId, req.id, response);
  return response;
}
