/**
 * Remote Control module — agent-triggered start/stop/status of the host-side
 * `claude remote-control` CLI.
 *
 * SECURITY: starting remote control hands a Claude.ai web/mobile URL to whoever
 * receives it; that URL drives the host install with full host privileges
 * (every tenant, every credential surface). It MUST NOT execute on a bare
 * agent-triggered system action — prompt injection in any tenant chat would
 * pivot to host hijack. Both `start_remote_control` and `stop_remote_control`
 * are gated through `requestApproval` so an owner/admin must click before the
 * CLI spawns. `cwd` is ignored from the agent payload and pinned to the host
 * project root at apply time.
 */

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getActiveSession, startRemoteControl, stopRemoteControl } from '../../remote-control.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, registerApprovalHandler, requestApproval, type ApprovalHandler } from '../approvals/index.js';

async function handleStartRemoteControl(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'start_remote_control failed: agent group not found.');
    return;
  }
  const sender = (content.sender as string) || 'unknown';
  const chatJid = (content.chatJid as string) || '';
  // NOTE: `cwd` is intentionally NOT carried through. Agent-supplied cwd would
  // let prompt injection root the remote-control CLI at any tenant's group
  // folder. The apply handler pins cwd to the host project root.
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'start_remote_control',
    payload: { sender, chatJid },
    title: 'Start Remote Control',
    question:
      `Agent "${agentGroup.name}" is requesting to start a Claude Code Remote Control session. ` +
      `Approving will spawn the host CLI and DM a remote-control URL into the calling chat — ` +
      `whoever sees that URL gets full host-level access (every tenant, every credential). ` +
      `Only approve if you initiated this and trust the chat surface.`,
  });
}

async function handleStopRemoteControl(_content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'stop_remote_control failed: agent group not found.');
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'stop_remote_control',
    payload: {},
    title: 'Stop Remote Control',
    question: `Agent "${agentGroup.name}" is requesting to stop the active Remote Control session.`,
  });
}

async function handleGetRemoteControlStatus(_content: Record<string, unknown>, session: Session): Promise<void> {
  // Read-only — does not need approval. Returns whether a session is active
  // and its URL, but does not start or stop anything.
  const active = getActiveSession();
  const text = active
    ? `Remote Control active (pid=${active.pid}): ${active.url}`
    : 'No active Remote Control session.';
  await notifyAgent(session, text);
}

const applyStartRemoteControl: ApprovalHandler = async ({ session, payload, notify }) => {
  const sender = (payload.sender as string) || 'unknown';
  const chatJid = (payload.chatJid as string) || '';
  // Pin cwd to a fixed safe location regardless of any agent-supplied value.
  const cwd = process.cwd();
  const result = await startRemoteControl(sender, chatJid, cwd);
  if (result.ok) {
    await notify(`Remote Control ready: ${result.url}`);
  } else {
    await notify(`Remote Control failed: ${result.error}`);
  }
  // Backstop notify on the session so the agent can relay; primitive notify
  // already targets the originating session, but keep behavior in line with
  // the previous direct-execute path. Best-effort: startRemoteControl above
  // already ran (this is an approval handler — an awaited rejection here
  // would propagate to response-handler.ts's catch, which attempts its own
  // fallback notify; if that ALSO fails, the approval row is never deleted
  // and stays clickable, risking a second remote-control spawn attempt).
  void Promise.resolve(
    notifyAgent(session, result.ok ? `Remote Control ready: ${result.url}` : `Remote Control failed: ${result.error}`),
  ).catch((err) => log.warn('start_remote_control backstop notification failed', { err }));
};

const applyStopRemoteControl: ApprovalHandler = async ({ session, notify }) => {
  const result = stopRemoteControl();
  const text = result.ok ? 'Remote Control stopped.' : `Remote Control: ${result.error}`;
  await notify(text);
  // Best-effort — see the matching comment in applyStartRemoteControl above.
  void Promise.resolve(notifyAgent(session, text)).catch((err) =>
    log.warn('stop_remote_control backstop notification failed', { err }),
  );
};

const REMOTE_CONTROL_ACTION = unguarded(
  'start/stop only create approval requests; status is read-only and all effects remain in approval handlers',
);
registerDeliveryAction('start_remote_control', handleStartRemoteControl, REMOTE_CONTROL_ACTION);
registerDeliveryAction('stop_remote_control', handleStopRemoteControl, REMOTE_CONTROL_ACTION);
registerDeliveryAction('get_remote_control_status', handleGetRemoteControlStatus, REMOTE_CONTROL_ACTION);
registerApprovalHandler('start_remote_control', applyStartRemoteControl);
registerApprovalHandler('stop_remote_control', applyStopRemoteControl);
