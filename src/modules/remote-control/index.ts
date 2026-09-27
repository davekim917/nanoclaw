/**
 * SECURITY: the remote-control URL drives the host install with full host
 * privileges, so start/stop MUST go through owner/admin approval (prompt
 * injection in any tenant chat would otherwise pivot to host hijack). `cwd`
 * from the agent payload is ignored and pinned to the host project root.
 */

import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getActiveSession, startRemoteControl, stopRemoteControl } from '../../remote-control.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, registerApprovalHandler, requestApproval, type ApprovalHandler } from '../approvals/index.js';

async function handleStartRemoteControl(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'start_remote_control failed: agent group not found.');
    return;
  }
  const sender = (content.sender as string) || 'unknown';
  const chatJid = (content.chatJid as string) || '';
  // `cwd` is intentionally NOT carried through: an agent-supplied cwd would let
  // prompt injection root the CLI at any tenant's group folder.
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
  const agentGroup = await getAgentGroup(session.agent_group_id);
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
  // Read-only, so no approval.
  const active = getActiveSession();
  const text = active
    ? `Remote Control active (pid=${active.pid}): ${active.url}`
    : 'No active Remote Control session.';
  await notifyAgent(session, text);
}

const applyStartRemoteControl: ApprovalHandler = async ({ session, payload, notify }) => {
  const sender = (payload.sender as string) || 'unknown';
  const chatJid = (payload.chatJid as string) || '';
  const cwd = process.cwd();
  const result = await startRemoteControl(sender, chatJid, cwd);
  if (result.ok) {
    await notify(`Remote Control ready: ${result.url}`);
  } else {
    await notify(`Remote Control failed: ${result.error}`);
  }
  // Best-effort, never awaited: in an approval handler an awaited rejection
  // whose fallback notify also fails leaves the approval row clickable,
  // risking a second remote-control spawn.
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
