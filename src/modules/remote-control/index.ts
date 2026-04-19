/**
 * Remote Control module (Phase 5.7) — agent-triggered start/stop/status
 * of the host-side `claude remote-control` CLI.
 *
 * Registers three delivery actions. The agent emits a system message via
 * MCP tools (container/agent-runner/src/mcp-tools/remote-control.ts) and
 * the host drives the CLI, then feeds the result back into the session
 * via notifyAgent so the agent can relay it to the user.
 */
import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../../delivery.js';
import { getActiveSession, startRemoteControl, stopRemoteControl } from '../../remote-control.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

async function handleStartRemoteControl(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const sender = (content.sender as string) || 'unknown';
  const chatJid = (content.chatJid as string) || '';
  const cwd = (content.cwd as string) || process.cwd();
  const result = await startRemoteControl(sender, chatJid, cwd);
  const text = result.ok ? `Remote Control ready: ${result.url}` : `Remote Control failed: ${result.error}`;
  notifyAgent(session, text);
}

async function handleStopRemoteControl(
  _content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const result = stopRemoteControl();
  const text = result.ok ? 'Remote Control stopped.' : `Remote Control: ${result.error}`;
  notifyAgent(session, text);
}

async function handleGetRemoteControlStatus(
  _content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const active = getActiveSession();
  const text = active
    ? `Remote Control active (pid=${active.pid}): ${active.url}`
    : 'No active Remote Control session.';
  notifyAgent(session, text);
}

registerDeliveryAction('start_remote_control', handleStartRemoteControl);
registerDeliveryAction('stop_remote_control', handleStopRemoteControl);
registerDeliveryAction('get_remote_control_status', handleGetRemoteControlStatus);
