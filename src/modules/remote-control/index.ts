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
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { getActiveSession, startRemoteControl, stopRemoteControl } from '../../remote-control.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, registerApprovalHandler, requestApproval, type ApprovalHandler } from '../approvals/index.js';

async function handleStartRemoteControl(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'start_remote_control failed: agent group not found.');
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

async function handleStopRemoteControl(
  _content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'stop_remote_control failed: agent group not found.');
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

async function handleGetRemoteControlStatus(
  _content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  // Read-only — does not need approval. Returns whether a session is active
  // and its URL, but does not start or stop anything.
  const active = getActiveSession();
  const text = active
    ? `Remote Control active (pid=${active.pid}): ${active.url}`
    : 'No active Remote Control session.';
  notifyAgent(session, text);
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
  // the previous direct-execute path.
  notifyAgent(session, result.ok ? `Remote Control ready: ${result.url}` : `Remote Control failed: ${result.error}`);
};

const applyStopRemoteControl: ApprovalHandler = async ({ session, notify }) => {
  const result = stopRemoteControl();
  const text = result.ok ? 'Remote Control stopped.' : `Remote Control: ${result.error}`;
  await notify(text);
  notifyAgent(session, text);
};

registerDeliveryAction('start_remote_control', handleStartRemoteControl);
registerDeliveryAction('stop_remote_control', handleStopRemoteControl);
registerDeliveryAction('get_remote_control_status', handleGetRemoteControlStatus);
registerApprovalHandler('start_remote_control', applyStartRemoteControl);
registerApprovalHandler('stop_remote_control', applyStopRemoteControl);
