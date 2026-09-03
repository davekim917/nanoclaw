/**
 * Delivery action handler for CLI requests from container agents.
 *
 * When an agent writes a `cli_request` system message to outbound.db,
 * the delivery poll picks it up and calls this handler. We dispatch
 * the command and write the response back to inbound.db.
 */
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { log } from '../log.js';
import { withMailboxSession } from '../session-manager.js';
import { dispatch } from './dispatch.js';
import type { RequestFrame } from './frame.js';

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

    log.info('CLI request from agent', { requestId, command, sessionId: session.id });

    const response = await dispatch(req, ctx);

    // Write response to inbound.db so the container can read it. Its own
    // short mailbox session — the delivery loop holds none while a handler
    // runs (plan §4.5b) — and `withMailboxSession`, not the existing-only
    // variant, because the response must land even for a session whose
    // mailbox was never provisioned; the container is waiting on it.
    // trigger=0: don't wake the agent — this is an inline response to a tool call.
    await withMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.insertMessage({
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

    log.info('CLI response written', { requestId, ok: response.ok, sessionId: session.id });
  },
  unguarded('transport envelope — every inner command is guarded at dispatch'),
);
